/**
 * /发明稿 orchestration: a real staged pipeline instead of one generic prompt.
 *
 *   1. 检索对比文件  AnySearch → CN publication numbers → Google Patents abstract (prior-art.ts)
 *   2. 撰写全文      INVENTION_SYSTEM + buildDraftPrompt, no web tools, cites only step-1 numbers
 *   3. 完整性        headings normalised; a reply that is not a full application (too short, too few
 *                    statutory sections, no numbered claims) is regenerated once, never "revised"
 *   4. 自检          deterministic audit (auditInvention): sections, claim tree, clarity, support, depth
 *   5. 修订          when the audit fails, one revision round fed with the failed checks; keep the better draft
 *   6. 落盘          draft goes to the case's 交底书 panel with its score, checks and prior art;
 *                    an incomplete draft is never stored
 *
 * The model call is injected (skill-run passes its streaming askModel) so this stays testable.
 */
import { ABSTRACT_MAX, abstractChars, abstractOverflow, cleanAbstractReply, compressAbstractPrompt, fitAbstract, guardCitations, locateAbstract, replaceAbstract } from "./draft-guards.ts";
import type { Dispatch } from "react";
import type { Action, InventionDraftState } from "./model.ts";
import { INVENTION_SYSTEM, auditInvention, auditNote, draftShape, normalizeDraftHeadings, safePreview, shapeNote } from "./invention-draft.ts";
import { MATH_REVIEW_SYSTEM, applyPatches, buildMathReviewPrompt, mathReviewNote, mathReviewRecord, parseMathReview, shouldReviewMath } from "./math-review.ts";
import type { MathReviewRecord } from "./math-review.ts";
import { auditFormulas, draftFormulaSources } from "./formula-audit.ts";
import { numberDescriptionFormulas } from "./formula-number.ts";
import { detectDomain, detectionNote, domainGuide } from "./patent-library.ts";
import type { DraftAudit, DraftShape, PriorArtRef } from "./invention-draft.ts";
import { draftQueries, gatherPriorArt, priorArtTrace } from "./prior-art.ts";
import type { LeadSearchResult, PageResult } from "./prior-art.ts";
import { buildChatMessages, clipText, createTopic, packMaterials, titleFromMaterials } from "./skill-turn.ts";
import type { PackedMaterial } from "./skill-turn.ts";
import { isDraftTailJson, stripDraftJsonTail } from "./figure-spec.ts";
import { formalCheck, parseApplication } from "./cnipa-format.ts";
import type { FormalReport } from "./cnipa-format.ts";
import { repairFigureRefs } from "./figure-ref-repair.ts";
import type { FigureRefRepairOptions } from "./figure-ref-repair.ts";
import { FIGURE_FILL_SYSTEM, figureFillPlan, figureFillPrompt, insertFigureBlocks, parseFigureFill } from "./figure-fill.ts";
import { expandDraft } from "./draft-expand.ts";
import { NOVELTY_MATERIAL_NAME } from "./novelty-check.ts";
import { stripInternalMarkers } from "./draft-polish.ts";

export interface DraftModelReply {
  ok: boolean;
  text: string;
  detail: string;
  model: string;
  aborted: boolean;
}

export type DraftAsk = (
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  onTrace: (text: string) => void,
  signal?: AbortSignal,
) => Promise<DraftModelReply>;

export interface DraftTurnInput {
  caseId: string;
  materials: PackedMaterial[];
  userText: string;
  facts?: string[];
  pursued?: string[];
  chosenPoint?: { title: string; problem?: string; feature?: string; effect?: string };
  /** 查新阶段已检索并逐项比对过的对比文件；给出时不再重复检索。 */
  priorArt?: PriorArtRef[];
  dispatch: Dispatch<Action>;
  signal?: AbortSignal;
}

export interface DraftDeps {
  ask: DraftAsk;
  search: (query: string) => Promise<LeadSearchResult>;
  extract?: (url: string) => Promise<PageResult>;
  /** Wait before the one automatic retry of a dropped full-draft call. Defaults to 3 s; tests pass 0. */
  retryDelayMs?: number;
  /** 成稿后按节扩写（创新点分析、背景技术、实施例），会多调用模型 2–4 次。真实流程开启；未设置时跳过。 */
  expand?: boolean;
}

export type DraftFailureKind = "network" | "timeout" | "rate-limit" | "upstream" | "auth" | "quota" | "empty" | "other";

export interface DraftFailure {
  kind: DraftFailureKind;
  /** What went wrong, in words the user can act on. */
  label: string;
  /** The same request can succeed a moment later, so the pipeline retries it with backoff. */
  retryable: boolean;
  /** The next step to offer when every retry has failed. */
  advice: string;
}

/**
 * Sort a model failure into something the user can act on. Order matters: the gateway's 429 text
 * (上游限流或额度不足) mentions 额度 too, so rate limiting is checked before an exhausted quota (402).
 */
export function classifyDraftFailure(detail: string): DraftFailure {
  const text = (detail || "").trim();
  if (!text || /空回答|空内容|没有返回内容/.test(text)) {
    return { kind: "empty", label: "模型返回了空内容", retryable: true, advice: "可以直接再发一次 /发明稿；反复出现时请换一个输出上限更大的模型。" };
  }
  if (/密钥无效|过期|没有这个模型的权限|没有服务端密钥|\b40[13]\b/.test(text)) {
    return { kind: "auth", label: "模型密钥无效或没有权限", retryable: false, advice: "请先到模型设置里检查或更换密钥，再发 /发明稿 继续成稿。" };
  }
  if (/限流|\b429\b/.test(text)) {
    return { kind: "rate-limit", label: "模型服务限流", retryable: true, advice: "稍等一两分钟再发 /发明稿，或换一个模型重试。" };
  }
  if (/额度不足|额度已用完|\b402\b/.test(text)) {
    return { kind: "quota", label: "模型额度不足", retryable: false, advice: "充值或换一个模型后再发 /发明稿。" };
  }
  if (/超时|timeout|timed out/i.test(text)) {
    return { kind: "timeout", label: "模型响应超时", retryable: true, advice: "全文较长，可以换一个响应更快的模型，或稍后再发 /发明稿。" };
  }
  if (/暂时故障|服务器错误|\b5\d\d\b/.test(text)) {
    return { kind: "upstream", label: "模型服务暂时故障", retryable: true, advice: "稍后再发 /发明稿，或换一个模型重试。" };
  }
  if (/没有连上|fetch failed|ECONN|UND_ERR|socket|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE/i.test(text)) {
    return { kind: "network", label: "与模型的网络连接中断", retryable: true, advice: "请检查网络或代理后再发 /发明稿，也可以换一个模型重试。" };
  }
  return { kind: "other", label: "模型没有完成这次请求", retryable: false, advice: "可以再发一次 /发明稿，或换一个模型重试。" };
}

/** A dropped connection, a timeout, rate limiting or a 5xx: the same request can succeed a moment later. */
export function isTransientDetail(detail: string): boolean {
  const failure = classifyDraftFailure(detail);
  return failure.retryable && failure.kind !== "empty";
}

/** Waits between full-draft attempts: 3 s, 15 s, 45 s with the default base. */
export function draftBackoff(baseMs: number): number[] {
  const base = Math.max(0, baseMs);
  return [base, base * 5, base * 15];
}

/** The user-facing note when the full draft could not be written after every retry. */
export function draftFailureNote(detail: string, attempts: number, topic: string, priorArt: PriorArtRef[]): string {
  const failure = classifyDraftFailure(detail);
  const lines = [`发明稿没有写成：${failure.label}${detail ? `（${detail}）` : ""}。卡在“撰写全文”阶段，共尝试 ${attempts} 次。`];
  const kept = [topic ? `选题「${topic}」` : "", priorArt.length ? `${priorArt.length} 条对比文件线索` : ""].filter(Boolean);
  if (kept.length) lines.push(`已保留${kept.join("和")}；候选题目和大纲仍在对话里。不完整的稿子没有保存，也不会导出。`);
  if (priorArt.length) lines.push(priorArtTrace(priorArt));
  lines.push(failure.advice);
  return lines.join("\n\n");
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface DraftTail {
  distinguishing: Array<{ feature: string; problem: string; effect: string }>;
  pending: string[];
  closestArt: string;
}

/**
 * Read the metadata json (distinguishing / pending / closestArt) the drafting prompt asks for. The model usually puts it
 * at the very end, but sometimes in the middle of the description or as a bare line without a fence; the last block that
 * really is that metadata wins, other json blocks (mislabelled figures, examples) are ignored. Missing or broken json
 * gives empty lists.
 */
export function parseDraftTail(text: string): DraftTail {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)].map((match) => match[1]).filter(isDraftTailJson);
  const loose = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && isDraftTailJson(line));
  const last = fenced.at(-1) ?? loose.at(-1);
  const empty: DraftTail = { distinguishing: [], pending: [], closestArt: "" };
  if (!last) return empty;
  try {
    const data = JSON.parse(last) as { distinguishing?: unknown[]; pending?: unknown[]; closestArt?: unknown };
    const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
    return {
      distinguishing: (data.distinguishing ?? [])
        .map((item) => {
          const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
          return { feature: str(row.feature), problem: str(row.problem), effect: str(row.effect) };
        })
        .filter((row) => row.feature)
        .slice(0, 8),
      pending: (data.pending ?? []).map(str).filter(Boolean).slice(0, 12),
      closestArt: str(data.closestArt),
    };
  } catch {
    return empty;
  }
}

/** The draft body without the machine-readable tail. */
export function draftBody(text: string): string {
  return stripDraftJsonTail(text).trim();
}

function revisionPrompt(draft: string, audit: DraftAudit, priorArt: PriorArtRef[], materials: PackedMaterial[], guide = ""): string {
  const failed = audit.checks.filter((item) => !item.ok);
  return [
    "下面是上一版发明专利申请文件草稿，以及确定性自检发现的问题。请逐条修正后输出完整的新版全文：",
    "- 结构和一级标题不变，最后仍附 json 代码块；",
    "- 输出全文，不要只输出修改部分，不要解释修改过程；",
    "- 不得编造实验数据、百分比、公开号或网址，材料中没有的数值写所属领域常规的取值范围及其确定方法，正文不写任何【待……】占位。",
    "",
    `【自检问题】\n${failed.map((item, index) => `${index + 1}. ${item.label}：${item.detail}`).join("\n")}`,
    "",
    guide ? `【领域撰写指引】\n${guide}\n` : "",
    `【可引用的对比文件】\n${priorArt.length ? priorArt.map((ref, index) => `[${index + 1}] ${ref.pn}《${ref.title}》${ref.url}${ref.note ? `\n    要点：${ref.note}` : ""}`).join("\n") : "（无。背景技术概括所属领域通行的现有技术路线并分析其缺陷，不写公开号，不加任何占位标记）"}`,
    "",
    `【交底材料（节选，用于补足说明书支持）】\n${packMaterials(materials, 9000)}`,
    "",
    `【上一版草稿】\n${clipText(draft, 40_000)}`,
  ].join("\n");
}

/** 导出前形式核查（解析为申请文件后的 formalCheck）。 */
function formalOf(text: string): FormalReport {
  return formalCheck(parseApplication(draftBody(text)));
}

function figureErrorCount(report: FormalReport): number {
  return report.figureAudit?.errorCount ?? 0;
}

/** 形式修正最多调用模型的轮数；每轮模型修正稿都先经过确定性的附图标记修复再判断是否采用。 */
export const FORMAL_REPAIR_ROUNDS = 2;

/**
 * 附图标记的确定性修复（见 figure-ref-repair.ts）：只在仍有附图致命问题时尝试，
 * 修复后申请文件结构完整、附图致命问题不增加才采用；返回 null 表示无可修或不采用。
 */
function repairFigureRefsIfBetter(
  text: string,
  formal: FormalReport,
  stage: string,
  trace: (line: string) => void,
  options: FigureRefRepairOptions = {},
): { text: string; formal: FormalReport } | null {
  if (formal.exportable || figureErrorCount(formal) === 0) return null;
  const repaired = repairFigureRefs(text, options);
  if (!repaired.changes.length) return null;
  const next = formalOf(repaired.text);
  const before = figureErrorCount(formal);
  const after = figureErrorCount(next);
  if (!draftShape(draftBody(repaired.text)).complete) {
    trace(`${stage}附图标记确定性修复会破坏申请文件结构，未采用。`);
    return null;
  }
  if (after > before) {
    trace(`${stage}附图标记确定性修复会使附图问题从 ${before} 项增加到 ${after} 项，未采用。`);
    return null;
  }
  trace(`${stage}附图标记确定性修复：${repaired.changes.join("；")}。${next.exportable ? "形式核查通过。" : `附图问题 ${before} → ${after} 项。`}`);
  return { text: repaired.text, formal: next };
}
/** 形式核查不通过（附图、附图标记不一致）时的修正提示：只改核查指出的问题，其余内容不动。 */
export function formalRepairPrompt(draft: string, report: FormalReport, guide = ""): string {
  const errors = report.checks.filter((check) => check.level === "error");
  const figureIds = new Set((report.figureAudit?.checks ?? []).map((check) => check.id));
  const figureWarnings = report.checks.filter((check) => check.level === "warn" && figureIds.has(check.id));
  return [
    "下面这版发明专利申请文件草稿没有通过导出前的形式核查，不能生成正式申请文件。请只修正下列问题，其余内容保持不变，输出完整的新版全文：",
    "- 结构和一级标题不变，最后仍附 json 代码块；输出全文，不要只输出修改部分，不要解释修改过程；",
    "- 附图说明、每幅图的附图绘图数据代码块、附图标记列表、具体实施方式中的引用必须一一对应：附图说明列出几幅图就给几个绘图数据代码块，图号一致；",
    "- 附图标记列表中的每个标记都必须画在某一幅图的绘图数据里；画不出来的部件，从附图标记列表和正文的标记引用中一并删去，不得保留未绘制的标记；",
    "- 修改部件的附图标记（改号、拆分重号）时，必须同时修改附图绘图数据中该部件图元的 ref，并同步修改附图标记列表、具体实施方式和权利要求中的“部件名(标记)”；不得只改列表或正文而让图中仍是旧标记，也不得让同一标记在不同附图中代表不同部件；",
    "- 流程图中的判断框必须有“是”“否”两个出口；只有一个出口的步骤改为普通处理框；",
    "- 不得编造实验数据、百分比、公开号或网址；原有的“（模拟值，待实验验证）”标注保留不动，不新增任何【待……】占位。",
    "",
    `【形式核查结论】\n${report.fatal}`,
    errors.length ? `\n【需修改】\n${errors.map((check, index) => `${index + 1}. ${check.label}：${check.detail}`).join("\n")}` : "",
    figureWarnings.length ? `\n【附图需注意】\n${figureWarnings.slice(0, 12).map((check, index) => `${index + 1}. ${check.label}：${check.detail}`).join("\n")}` : "",
    "",
    guide ? `【领域撰写指引】\n${guide}\n` : "",
    `【上一版草稿】\n${clipText(draft, 40_000)}`,
  ].join("\n");
}
/** Follow-up turn when the model answered with something that is not a full application. */
function retryPrompt(shape: DraftShape): string {
  return [
    `上一次回复不是完整的申请文件（${shape.reason}${shape.missing.length ? `；缺少：${shape.missing.join("、")}` : ""}）。`,
    "请现在直接输出完整的发明专利申请文件草稿：",
    "- 严格按系统要求的 Markdown 结构，从「# 发明名称」开始，七个「## 」一级标题齐全（化学、医药等确无附图的申请可删去附图说明）；",
    "- 权利要求按「1.」「2.」连续编号，具体实施方式写出完整实施例；",
    "- 不要提问，不要解释，不要只给提纲或分段输出；材料中没有的信息写所属领域常规的取值范围及其确定方法，正文不写任何【待……】占位；",
    "- 最后另起一个 json 代码块。",
  ].join("\n");
}

function tailNote(tail: DraftTail): string {
  const lines: string[] = [];
  if (tail.closestArt) lines.push(`最接近的现有技术：${tail.closestArt}`);
  if (tail.distinguishing.length) {
    lines.push("区别技术特征（创造性论证的抓手）：");
    tail.distinguishing.forEach((row, index) => {
      lines.push(`${index + 1}. ${row.feature}${row.problem ? `｜解决：${row.problem}` : ""}${row.effect ? `｜效果：${row.effect}` : ""}`);
    });
  }
  if (tail.pending.length) {
    lines.push("需要你补充确认：");
    tail.pending.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }
  return lines.join("\n");
}

export async function runDraftTurn(input: DraftTurnInput, deps: DraftDeps): Promise<void> {
  const { dispatch, caseId, signal } = input;
  const trace = (text: string) => dispatch({ type: "chat-note", caseId, role: "trace", text });
  const stopped = () => dispatch({ type: "chat-note", caseId, role: "assistant", text: "已停止这一轮。" });
  const corpus = input.materials.map((item) => item.text).join("\n");

  trace("发明稿流水线：① 识别技术领域并检索对比文件 → ② 区别技术特征与权利要求布局 → ③ 说明书全文 → ④ 领域化自检 → ⑤ 必要时修订一轮 → ⑥ 分节扩写（创新点分析、背景技术、多实施例与效果分析）。");

  // 技术领域：决定权利要求主题布局、附图标记和自检口径
  const detection = detectDomain([input.chosenPoint?.title, input.chosenPoint?.feature, input.userText, corpus].filter(Boolean).join("\n"));
  const guide = domainGuide(detection.domain, detection);
  trace(detectionNote(detection));

  // ① prior art
  const topic = createTopic(input.userText) || input.chosenPoint?.title || input.pursued?.[0] || titleFromMaterials(input.materials, corpus);
  const queries = draftQueries(topic, input.chosenPoint?.feature);
  const priorArt = input.priorArt?.length
    ? input.priorArt
    : queries.length
    ? await gatherPriorArt(queries, {
        search: deps.search,
        extract: deps.extract,
        onTrace: trace,
        signal,
        limit: 8,
        enrich: 5,
        topic: [topic, input.chosenPoint?.feature].filter(Boolean).join(" "),
      })
    : [];
  if (signal?.aborted) return stopped();
  if (input.priorArt?.length) trace(`沿用查新阶段逐项比对过的 ${input.priorArt.length} 篇对比文件，不再重复检索。`);
  trace(priorArtTrace(priorArt));

  // ② + ③ full draft
  trace(`正在撰写全文：权利要求书（${detection.domain.name}常见主题：${detection.domain.claimKinds.join("、")}，按发明实际客体取舍）、说明书五部分和摘要。全文较长，通常需要一到三分钟。`);
  const messages = buildChatMessages({
    materials: input.materials,
    history: [],
    userText: input.userText,
    intent: "draft",
    pursued: input.pursued,
    facts: input.facts,
    priorArt,
    chosenPoint: input.chosenPoint,
    domainGuide: guide,
  });
  let first = await deps.ask(messages, trace, signal);
  if (signal?.aborted || first.aborted) return stopped();
  // Network drops, timeouts, rate limits and 5xx are retried with backoff; a bad key or an exhausted quota is not.
  const backoff = draftBackoff(deps.retryDelayMs ?? 3000);
  let attempts = 1;
  while (!first.ok && isTransientDetail(first.detail) && attempts <= backoff.length) {
    const delay = backoff[attempts - 1];
    const failure = classifyDraftFailure(first.detail);
    trace(`撰写全文第 ${attempts} 次失败：${failure.label}（${first.detail}）。${Math.round(delay / 1000)} 秒后自动重试（第 ${attempts + 1}/${backoff.length + 1} 次）。`);
    await wait(delay, signal);
    if (signal?.aborted) return stopped();
    first = await deps.ask(messages, trace, signal);
    attempts += 1;
    if (signal?.aborted || first.aborted) return stopped();
  }
  if (!first.ok || !first.text.trim()) {
    dispatch({ type: "chat-note", caseId, role: "assistant", text: draftFailureNote(first.detail || "模型没有返回内容", attempts, topic, priorArt) });
    return;
  }

  // ③ completeness: a short or unstructured reply is regenerated, not "revised"
  let text = normalizeDraftHeadings(first.text.trim());
  let model = first.model;
  let shape = draftShape(draftBody(text));
  trace(shapeNote("初稿", shape));
  if (!shape.complete) {
    trace(`初稿不完整（${shape.reason}），开头是「${safePreview(draftBody(text))}」。不拿它做修订，按原始要求重新生成一次全文。`);
    const retry = await deps.ask(
      [...messages, { role: "assistant", content: clipText(first.text.trim(), 4000) }, { role: "user", content: retryPrompt(shape) }],
      trace,
      signal,
    );
    if (signal?.aborted || retry.aborted) return stopped();
    const retryText = retry.ok ? normalizeDraftHeadings(retry.text.trim()) : "";
    const retryShape = draftShape(draftBody(retryText));
    trace(retryText ? shapeNote("重写稿", retryShape) : `重写没有完成（${retry.detail || "无返回"}）。`);
    if (!retryShape.complete) {
      dispatch({
        type: "chat-note",
        caseId,
        role: "assistant",
        text: `发明稿没有写成：模型两次都没有返回完整的申请文件（${retryText ? retryShape.reason : shape.reason}）。这份不完整的稿子没有保存，也不会导出。可以再发一次 /发明稿；反复出现时请换一个输出上限更大的模型。`,
      });
      return;
    }
    text = retryText;
    shape = retryShape;
    model = retry.model || model;
  }

  // ④ audit
  let audit = auditInvention(draftBody(text), { domain: detection.domain, priorArt: priorArt.map((ref) => ref.pn) });
  let revised = false;
  trace(`自检 ${audit.score} 分：${audit.checks.filter((item) => !item.ok).map((item) => item.label).join("、") || "结构检查全部通过"}。`);

  // ⑤ one revision round
  const failed = audit.checks.filter((item) => !item.ok);
  if (failed.length && audit.score < 90) {
    trace(`按 ${failed.length} 项自检问题自动修订一轮。`);
    const second = await deps.ask(
      [
        { role: "system", content: INVENTION_SYSTEM },
        { role: "user", content: revisionPrompt(draftBody(text), audit, priorArt, input.materials, guide) },
      ],
      trace,
      signal,
    );
    if (signal?.aborted || second.aborted) return stopped();
    if (second.ok && second.text.trim()) {
      const secondText = normalizeDraftHeadings(second.text.trim());
      const nextShape = draftShape(draftBody(secondText));
      const nextAudit = auditInvention(draftBody(secondText), { domain: detection.domain, priorArt: priorArt.map((ref) => ref.pn) });
      if (!nextShape.complete) {
        trace(`修订稿不完整（${nextShape.reason}），保留原稿。`);
      } else if (nextAudit.score >= audit.score) {
        trace(`修订后 ${nextAudit.score} 分（修订前 ${audit.score} 分），采用修订稿。`);
        text = secondText;
        audit = nextAudit;
        revised = true;
        model = second.model || model;
      } else {
        trace(`修订稿只有 ${nextAudit.score} 分，低于原稿 ${audit.score} 分，保留原稿。`);
      }
    } else {
      trace(`修订没有完成（${second.detail || "无返回"}），保留原稿。`);
    }
  }

  // ⑤⅛ 附图数据补绘：附图说明列出了图，但草稿缺少这些图的 ```附图 绘图数据（模型漏写，或写成了无法识别的格式）时，
  //     导出只能留空白虚线框。单独请模型只补写缺的几幅，经解析、规范化后插回附图说明末尾；无可用数据、插入后无法识别或破坏结构时不采用。
  //     补图后照常做确定性标记修复和形式修正；最终仍不能导出而补图前可以导出时，回退到补图前的稿子。
  let beforeFill: { text: string; audit: DraftAudit } | null = null;
  const fillPlan = figureFillPlan(draftBody(text));
  if (fillPlan.missing.length) {
    const missingNos = fillPlan.missing.map((figure) => figure.no);
    trace(`附图说明列出的图${missingNos.join("、图")}没有绘图数据，导出时只能留空白框。单独补绘这 ${missingNos.length} 幅图的附图数据。`);
    const filled = await deps.ask(
      [
        { role: "system", content: FIGURE_FILL_SYSTEM },
        { role: "user", content: figureFillPrompt(draftBody(text), fillPlan, guide) },
      ],
      trace,
      signal,
    );
    if (signal?.aborted || filled.aborted) return stopped();
    if (!filled.ok || !filled.text.trim()) {
      trace(`补绘附图数据没有完成（${filled.detail || "无返回"}），保留原稿。`);
    } else {
      const parsed = parseFigureFill(filled.text, fillPlan.missing);
      const notes = parsed.notes.length ? clipText(parsed.notes.join("；"), 160) : "";
      if (!parsed.specs.length) {
        trace(`补绘回复中没有可用的附图数据${notes ? `（${notes}）` : ""}，保留原稿。`);
      } else {
        const candidate = insertFigureBlocks(text, parsed.specs);
        const stillMissing = figureFillPlan(draftBody(candidate)).missing.length;
        if (!draftShape(draftBody(candidate)).complete) {
          trace("补绘的附图数据插入后会破坏申请文件结构，保留原稿。");
        } else if (stillMissing >= missingNos.length) {
          trace("补绘的附图数据插入后未能被识别，保留原稿。");
        } else {
          beforeFill = { text, audit };
          text = candidate;
          audit = auditInvention(draftBody(text), { domain: detection.domain, priorArt: priorArt.map((ref) => ref.pn) });
          trace(`已补绘图${parsed.specs.map((spec) => spec.no).join("、图")}的附图数据${stillMissing ? `，仍缺 ${stillMissing} 幅` : ""}${notes ? `（${notes}）` : ""}。`);
        }
      }
    }
  }

  // ⑤¼ 导出前形式核查：附图与附图标记的致命问题会使申请文件无法导出。
  //     先做确定性修复（补列名称确定的标记、去掉无名称且未引用的图元标记、删去未绘制且未引用的列表项）；
  //     仍不通过时按核查结果让模型修正，最多 FORMAL_REPAIR_ROUNDS 轮，每轮修正稿先做确定性修复再判断。
  //     修正稿不完整、附图问题不减少或自检分明显下降时保留当前稿并停止，不会无限调用模型。
  //     模型修正后仍有未绘制、正文只以“部件名+标记”引用的部件时，最后去掉这些标记引用并从列表删去（部件名称保留）。
  let formal = formalOf(text);
  const repairRefs = (stage: string, options: FigureRefRepairOptions = {}) => {
    const repaired = repairFigureRefsIfBetter(text, formal, stage, trace, options);
    if (!repaired) return;
    text = repaired.text;
    formal = repaired.formal;
    audit = auditInvention(draftBody(text), { domain: detection.domain, priorArt: priorArt.map((ref) => ref.pn) });
  };
  repairRefs("导出前");
  for (let round = 1; round <= FORMAL_REPAIR_ROUNDS && !formal.exportable && figureErrorCount(formal) > 0; round += 1) {
    const before = figureErrorCount(formal);
    trace(`导出前形式核查未通过：${clipText(formal.fatal, 200)}。按核查结果自动修正（第 ${round}/${FORMAL_REPAIR_ROUNDS} 轮）。`);
    const fixed = await deps.ask(
      [
        { role: "system", content: INVENTION_SYSTEM },
        { role: "user", content: formalRepairPrompt(draftBody(text), formal, guide) },
      ],
      trace,
      signal,
    );
    if (signal?.aborted || fixed.aborted) return stopped();
    if (!fixed.ok || !fixed.text.trim()) {
      trace(`形式修正没有完成（${fixed.detail || "无返回"}），保留当前稿。`);
      break;
    }
    let fixedText = normalizeDraftHeadings(fixed.text.trim());
    let fixedFormal = formalOf(fixedText);
    const polished = repairFigureRefsIfBetter(fixedText, fixedFormal, `第 ${round} 轮修正稿`, trace);
    if (polished) {
      fixedText = polished.text;
      fixedFormal = polished.formal;
    }
    const fixedShape = draftShape(draftBody(fixedText));
    const after = figureErrorCount(fixedFormal);
    const fixedAudit = auditInvention(draftBody(fixedText), { domain: detection.domain, priorArt: priorArt.map((ref) => ref.pn) });
    if (!fixedShape.complete) {
      trace(`形式修正稿不完整（${fixedShape.reason}），保留当前稿。`);
      break;
    }
    if (!fixedFormal.exportable && after >= before) {
      trace(`形式修正稿仍有 ${after} 项附图问题（修正前 ${before} 项），保留当前稿。`);
      break;
    }
    if (fixedAudit.score < audit.score - 10) {
      trace(`形式修正稿自检只有 ${fixedAudit.score} 分（修正前 ${audit.score} 分），保留当前稿。`);
      break;
    }
    trace(`第 ${round} 轮形式修正后${fixedFormal.exportable ? "核查通过" : `附图问题 ${before} → ${after} 项`}，自检 ${fixedAudit.score} 分，采用修正稿。`);
    text = fixedText;
    audit = fixedAudit;
    formal = fixedFormal;
    model = fixed.model || model;
  }
  // 模型修正之后仍有附图致命问题时的兜底：没有附图画出、说明书和权利要求只以“部件名+标记”引用的部件，
  //     去掉这些标记引用（部件名称保留）并从附图标记列表删去。放在模型修正之后，是为了先让模型有机会把部件补画进附图。
  if (!formal.exportable && figureErrorCount(formal) > 0) repairRefs("形式修正后", { unrefUndrawn: true });
  // 补绘的附图经修正后仍使申请文件无法导出，而补图前可以导出时，回退到补图前的稿子，不让补图把可交付的稿子变成不可导出。
  if (beforeFill && !formal.exportable) {
    const previous = formalOf(beforeFill.text);
    if (previous.exportable) {
      trace(`补绘附图后形式核查仍未通过（${clipText(formal.fatal, 160)}），回退到补绘前的稿子；没有绘图数据的附图在正式文件中为空白虚线框。`);
      text = beforeFill.text;
      audit = beforeFill.audit;
      formal = previous;
    }
  }
  // ⑤½ 公式与参数专项审阅：模型只给定点补丁，逐条套用；套用后公式形式错误和附图问题都不增加才采用
  let mathReview: MathReviewRecord | undefined;
  if (shouldReviewMath(draftBody(text))) {
    trace("公式与参数专项审阅：检查坐标与符号约定、边界条件、量纲换算、取值边界和跨章节一致性，只做定点修改。");
    const reviewed = await deps.ask(
      [
        { role: "system", content: MATH_REVIEW_SYSTEM },
        { role: "user", content: buildMathReviewPrompt(draftBody(text), guide) },
      ],
      trace,
      signal,
    );
    if (signal?.aborted || reviewed.aborted) return stopped();
    if (reviewed.ok && reviewed.text.trim()) {
      const parsed = parseMathReview(reviewed.text);
      const patched = applyPatches(text, parsed.patches);
      const formulaErrors = (draft: string) => auditFormulas(draftFormulaSources(draft)).issues.filter((item) => item.level === "error").length;
      const before = formulaErrors(draftBody(text));
      const after = patched.applied.length ? formulaErrors(draftBody(patched.text)) : before;
      const complete = patched.applied.length ? draftShape(draftBody(patched.text)).complete : true;
      const figuresBefore = figureErrorCount(formalOf(text));
      const figuresAfter = patched.applied.length ? figureErrorCount(formalOf(patched.text)) : figuresBefore;
      const accepted = patched.applied.length > 0 && complete && after <= before && figuresAfter <= figuresBefore;
      mathReview = mathReviewRecord(patched, parsed.notes, accepted);
      if (accepted) {
        text = patched.text;
        audit = auditInvention(draftBody(text), { domain: detection.domain, priorArt: priorArt.map((ref) => ref.pn) });
        trace(`公式审阅给出 ${parsed.patches.length} 条修改，套用 ${patched.applied.length} 条${patched.skipped.length ? `，${patched.skipped.length} 条无法唯一定位未套用` : ""}；公式形式错误 ${before} → ${after} 处，自检 ${audit.score} 分。`);
      } else if (patched.applied.length) {
        const reason = !complete
          ? "会破坏申请文件结构"
          : after > before
            ? `会使公式形式错误从 ${before} 处增加到 ${after} 处`
            : `会使附图问题从 ${figuresBefore} 项增加到 ${figuresAfter} 项`;
        trace(`公式审阅的修改${reason}，整体放弃，保留原稿。`);
      } else {
        trace(parsed.patches.length ? `公式审阅给出 ${parsed.patches.length} 条修改，均无法在原文中唯一定位，保留原稿。` : "公式审阅没有发现需要修改的地方。");
      }
    } else {
      trace(`公式审阅没有完成（${reviewed.detail || "无返回"}），保留原稿。`);
    }
  }

  // ⑤⅞ 分节扩写：主稿受单次输出上限所限，创新点分析、背景技术和具体实施方式往往偏短。按节单独补写后插回原稿；
  //     结构不完整、附图问题增加、原本可导出变为不可导出或自检明显下降的那一步不采用（见 draft-expand.ts）。
  const expansion = deps.expand
    ? await expandDraft(
    {
      text,
      priorArt,
      novelty: input.materials.find((item) => item.name === NOVELTY_MATERIAL_NAME)?.text ?? "",
      auto: /全自动模式/.test(input.userText),
      trace,
      signal,
      evaluate: (candidate) => {
        const candidateFormal = formalOf(candidate);
        return {
          complete: draftShape(draftBody(candidate)).complete,
          score: auditInvention(draftBody(candidate), { domain: detection.domain, priorArt: priorArt.map((ref) => ref.pn) }).score,
          exportable: candidateFormal.exportable,
          figureErrors: figureErrorCount(candidateFormal),
        };
      },
    },
    { ask: deps.ask },
  )
    : { text, changed: false, aborted: false, added: [] as string[] };
  if (signal?.aborted || expansion.aborted) return stopped();
  if (expansion.changed) {
    text = expansion.text;
    audit = auditInvention(draftBody(text), { domain: detection.domain, priorArt: priorArt.map((ref) => ref.pn) });
    formal = formalOf(text);
    trace(`分节扩写完成（${expansion.added.join("、")}），全文约 ${draftBody(text).replace(/\s/g, "").length} 字。`);
  }

  // ⑥ 确定性兜底：正文只认本次检索到的公开号；说明书摘要硬性不超过上限
  const citeGuard = guardCitations(text, priorArt.map((ref) => ref.pn));
  if (citeGuard.unknown.length) {
    text = citeGuard.text;
    trace(`正文出现本次检索结果之外的公开号：${citeGuard.unknown.join("、")}，已就地标注“待核实”，不当作对比文件。`);
  }
  const abstractBlock = abstractOverflow(text) > 0 ? locateAbstract(text) : null;
  if (abstractBlock) {
    trace(`说明书摘要 ${abstractChars(abstractBlock.text)} 字，超过 ${ABSTRACT_MAX} 字上限，单独压缩一次。`);
    const shortened = await deps.ask(
      [
        { role: "system", content: INVENTION_SYSTEM },
        { role: "user", content: compressAbstractPrompt(abstractBlock.text) },
      ],
      trace,
      signal,
    );
    if (signal?.aborted || shortened.aborted) return stopped();
    const candidate = shortened.ok ? cleanAbstractReply(shortened.text) : "";
    const usable = abstractChars(candidate) >= 60 && abstractChars(candidate) <= ABSTRACT_MAX;
    const fitted = usable ? candidate : fitAbstract(abstractBlock.text);
    trace(usable ? `摘要已压缩为 ${abstractChars(fitted)} 字。` : `压缩结果不合格（${shortened.ok ? `${abstractChars(candidate)} 字` : shortened.detail || "无返回"}），按句截短为 ${abstractChars(fitted)} 字。`);
    text = replaceAbstract(text, fitted);
  }
  if (citeGuard.unknown.length || abstractBlock) audit = auditInvention(draftBody(text), { domain: detection.domain, priorArt: priorArt.map((ref) => ref.pn) });
  formal = formalOf(text);
  // 公式审阅、摘要压缩等后续修改之后的兜底：附图标记仍不一致时再做一次确定性修复
  repairRefs("成稿前");
  // ⑦ 成稿清洗：去掉模型偶发写进正文的内部检索提示（如“【待检索补充对比文件】”），用户看到的稿件和导出的 Word 都是正式文本。
  const polished = stripInternalMarkers(text);
  if (polished.removed.length) {
    text = polished.text;
    audit = auditInvention(draftBody(text), { domain: detection.domain, priorArt: priorArt.map((ref) => ref.pn) });
    formal = formalOf(text);
    trace(`成稿清洗：去掉 ${polished.removed.length} 处内部提示标记（${[...new Set(polished.removed)].join("、")}）。`);
  }
  // ⑦½ 说明书公式编号：说明书独立公式全部未编号、正文也没有“式（n）”引用时，按出现顺序补（1）（2）…（确定性，公式内容不变）
  const formulaNumbers = numberDescriptionFormulas(text);
  if (formulaNumbers.numbered) {
    text = formulaNumbers.text;
    audit = auditInvention(draftBody(text), { domain: detection.domain, priorArt: priorArt.map((ref) => ref.pn) });
    formal = formalOf(text);
    trace(`说明书公式编号：按出现顺序为 ${formulaNumbers.numbered} 个独立公式补上（1）至（${formulaNumbers.numbered}）。`);
  }
  const tail = parseDraftTail(text);
  const body = draftBody(text);
  const draft: InventionDraftState = {
    text: body,
    score: audit.score,
    at: new Date().toISOString(),
    model,
    revised,
    pendingMarks: audit.pendingMarks,
    claimCount: audit.claims.length,
    priorArt,
    checks: audit.checks.map((item) => ({ label: item.label, ok: item.ok, detail: item.detail })),
    distinguishing: tail.distinguishing,
    pending: tail.pending,
    domain: detection.domain.id,
    domainName: detection.domain.name,
    mathReview,
  };
  dispatch({ type: "set-invention-draft", caseId, draft });
  dispatch({
    type: "chat-note",
    caseId,
    role: "assistant",
    text: [
      formal.exportable
        ? `发明专利申请文件草稿已写好，下方可以分件下载全部申请文件（Word），也可以一键打包下载。全文约 ${body.replace(/\s/g, "").length} 字${revised ? "，已按自检结果修订一轮" : ""}。`
        : `发明专利申请文件草稿已写好（全文约 ${body.replace(/\s/g, "").length} 字${revised ? "，已按自检结果修订一轮" : ""}），但导出前形式核查没有通过，暂时不能生成 Word：${formal.fatal}`,      auditNote(audit),
      mathReviewNote(mathReview),
      tailNote(tail),
      "这是交给代理人审核的草稿，不是法律意见；对比文件是公开网页线索，提交前请到国家知识产权局系统核实。",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
}
