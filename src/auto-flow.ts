/**
 * 全自动成稿：发明人说“不要问我，直接做”时，一次跑完 选题 → 大纲 → 完整申请文件 → Word。
 * 全程不提问、不停下等确认：材料里没有的数值用显式标注的模拟值，检索结果只当线索，附图按草稿中的附图数据自动绘制。
 */
import type { Dispatch } from "react";
import type { Action, ChatMessage, InventionDraftState } from "./model.ts";
import { runDraftTurn } from "./draft-run.ts";
import { OUTLINE_MATERIAL_NAME, buildChatMessages, clipText, createTopic, parseSlash, titleFromMaterials, type PackedMaterial, type SlashIntent } from "./skill-turn.ts";
import { formalCheck, parseApplication } from "./cnipa-format.ts";
import type { PriorArtRef } from "./invention-draft.ts";
import { NOVELTY_MATERIAL_NAME, noveltySummary, runNoveltyCheck } from "./novelty-check.ts";

export const AUTO_TRACE_PREFIX = "专利技能：全自动成稿";
export const AUTO_TOPIC_MATERIAL_NAME = "创作选题.md";
export const SIMULATED_MARK = "（模拟值，待实验验证）";

export const AUTO_DIRECTIVE = [
  "【全自动模式】发明人明确要求不要再询问、直接完成。",
  "- 不要提问，不要停下来等确认；需要发明人决定的地方，按所属领域的通常做法直接决定，并在文末以“默认假设（可后续修改）”列出。",
  `- 材料中没有的参数、尺寸、阈值、配比等数值，给出合理的模拟值，并在每个数值后紧跟“${SIMULATED_MARK}”；技术效果只写定性描述或“预期……${SIMULATED_MARK}”，不得写成实测结论。`,
  "- 检索到的专利、论文和网页只是线索，不得声称已核验对比文件；不得编造公开号、网址、实验数据或测试结果。",
].join("\n");

export const AUTO_DRAFT_TEXT = [
  AUTO_DIRECTIVE,
  "- 按选题和大纲一次写完整的发明专利申请文件；附图说明逐幅写“图N为……示意图/流程图”，并按附图数据规范为每幅图给出 ```附图 JSON 代码块，导出时自动绘制为黑白线条图。",
  "- 材料中有《查新对比报告》时：背景技术逐篇评述报告中的对比文件；权利要求1必须包含报告列出的全部区别技术特征；发明内容写“### 创新点分析”，与区别技术特征和有益效果一一对应。",
].join("\n");

export interface AutoPoint {
  title: string;
  problem: string;
  feature: string;
  effect: string;
  pending: string;
}

export interface AutoReply {
  ok: boolean;
  text: string;
  detail: string;
  model: string;
  aborted: boolean;
  /** 本轮已经拿到的检索线索；回复中途失败时也会带回来。 */
  sources?: AutoClue[];
}

export type AutoClue = { n: number; title: string; url: string };

type ModelMessage = { role: "system" | "user" | "assistant"; content: string };

export interface AutoDeps {
  /** 选题（create，可联网）和大纲（outline）两步用的模型调用。 */
  ask: (messages: ModelMessage[], intent: SlashIntent, onTrace: (text: string) => void, signal?: AbortSignal) => Promise<AutoReply>;
  /** 成稿流水线的依赖（模型、检索、网页抽取）。 */
  draft: Parameters<typeof runDraftTurn>[1];
}

export interface AutoInput {
  caseId: string;
  userText: string;
  history?: ChatMessage[];
  materials: PackedMaterial[];
  /** 案件里已有的候选题目：有已选定的就用它，否则用第一个，不再重新选题。 */
  ideas?: Array<{ title: string; problem?: string; feature?: string; effect?: string; pending?: string; status?: string }>;
  facts?: string[];
  dispatch: Dispatch<Action>;
  signal?: AbortSignal;
}

export interface AutoOutcome {
  stage: "draft" | "failed" | "stopped";
  chosen?: AutoPoint;
  outline: boolean;
  draft?: InventionDraftState;
}

const AUTO_PATTERNS: RegExp[] = [
  /(?:不要|别|不用|无需|无须|不必|甭)(?:再)?(?:询问|追问|提问|问我|问了|问|确认)/,
  /直接(?:帮我|给我|替我|就)?(?:做(?!成)|写(?!成|入|在)|开始|生成|出稿|成稿|完成|动手)/,
  /按(?:照)?你(?:的|自己的)(?:想法|思路|意思|方案|推荐|理解|判断)/,
  /你(?:自己)?(?:看着办|决定吧|来定|定吧|拿主意)/,
  /(?:先|就)按.{0,12}?(?:建议值|默认|假设|推荐).{0,10}?(?:完成|写完|写|做|成稿)/,
  /全自动|一键(?:成稿|生成|写完|出稿)/,
];

/**
 * 发明人要求“不要问，直接做”。斜杠命令另行处理。
 * 长文本（多半是交底描述）只看开头和结尾：指令通常写在这两处，正文里的“无需确认”不算。
 */
export function detectAutoRequest(text: string): boolean {
  const value = text.trim();
  if (!value || value.startsWith("/")) return false;
  const scope = value.length > 200 ? `${value.slice(0, 80)}\n${value.slice(-120)}` : value;
  return AUTO_PATTERNS.some((pattern) => pattern.test(scope));
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

const PROSE_LINE = /^\s*(?:#{1,6}\s*|[-*+]\s+|\d{1,2}\s*[.、．)）]\s*|[（(]\d{1,2}[)）]\s*|(?:候选)?(?:题目|方案|选题)\s*[一二三四五六七八九\d]*\s*[：:]\s*)/;
const PROSE_TITLE = /一种[^\n，,。；;：:*`|（）()《》「」"“”、!！?？—–]{4,60}/;
const TITLE_END = /(?:方法|系统|装置|设备|平台|终端|介质|机器人|传感器|工艺|组合物|材料|模型|结构|机构|组件|器|仪|机|剂)$/;

/** 模型没给 json 时，从正文的编号列表或小标题里认“一种……方法/系统/装置”式的候选题目。 */
export function proseCandidates(visible: string): { visible: string; points: AutoPoint[]; recommended: number } {
  const titles: string[] = [];
  let recommended = -1;
  const lines = visible.split(/\r?\n/);
  for (const line of lines) {
    if (!PROSE_LINE.test(line)) continue;
    const clean = line.replace(/\*\*|__/g, "").replace(/(?:发明名称|题目)\s*[：:]\s*/g, "");
    const found = clean.match(PROSE_TITLE)?.[0].trim();
    if (!found || !TITLE_END.test(found) || titles.includes(found)) continue;
    titles.push(found);
    if (recommended < 0 && /推荐|首选|优先/.test(clean)) recommended = titles.length - 1;
    if (titles.length >= 5) break;
  }
  if (recommended < 0) {
    const hint = lines.find((line) => /推荐|首选/.test(line) && titles.some((title) => line.includes(title)));
    recommended = hint ? titles.findIndex((title) => hint.includes(title)) : 0;
  }
  const points = titles.map((title) => ({ title, problem: "", feature: "", effect: "", pending: "" }));
  return { visible, points, recommended: points.length ? Math.max(0, recommended) : 0 };
}

/** 稿子首行「# 发明名称：……」里的题目；模板占位的“一种……”不算。 */
export function draftTitle(text: string): string {
  const line = text.match(/^#(?!#)\s*(.+?)\s*$/m)?.[1] ?? "";
  const title = line.replace(/^发明名称\s*[：:]?\s*/, "").replace(/[*`]/g, "").trim();
  return !title || title.includes("……") ? "" : title;
}

function pnKey(value: string): string {
  return value.toUpperCase().replace(/\s+/g, "").match(/CN(\d{8,12})/)?.[1] ?? "";
}

/** 稿子里出现、但不在检索到的对比文件里的中国专利号：可能是模型凭记忆写的，必须提示核实。 */
export function unverifiedPatentNumbers(draft: Pick<InventionDraftState, "text" | "priorArt">): string[] {
  const known = new Set(draft.priorArt.map((item) => pnKey(item.pn)).filter(Boolean));
  const found = new Map<string, string>();
  for (const match of draft.text.matchAll(/CN\s?\d{8,12}(?:\.\d)?\s?[A-Z]?\d?/gi)) {
    const key = pnKey(match[0]);
    if (key && !known.has(key) && !found.has(key)) found.set(key, match[0].replace(/\s+/g, "").toUpperCase());
  }
  return [...found.values()];
}

type LooseRecord = Record<string, unknown>;

function isRecord(value: unknown): value is LooseRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 严格解析失败时做最小修补：去掉整行 // 注释和末尾多余的逗号，再试最外层花括号；顶层是数组时当作候选列表。 */
function looseJson(raw: string): LooseRecord | null {
  const body = raw.trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  const bases = start >= 0 && end > start && (start > 0 || end < body.length - 1) ? [body, body.slice(start, end + 1)] : [body];
  for (const base of bases) {
    for (const candidate of [base, base.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")]) {
      try {
        const value: unknown = JSON.parse(candidate);
        if (isRecord(value)) return value;
        if (Array.isArray(value)) return { candidates: value };
      } catch {
        // 修补后仍不是 JSON，试下一种
      }
    }
  }
  return null;
}

const LIST_KEYS = ["patentPoints", "points", "ideas", "candidates", "topics", "候选题目", "候选", "题目列表", "选题"];
const NON_POINT_KEYS = new Set(["questions", "sources", "references", "facts", "assumptions", "问题", "默认假设"]);

function titleOf(item: LooseRecord): string {
  return str(item.title ?? item.name ?? item["题目"] ?? item["发明名称"] ?? item["候选题目"] ?? item.topic);
}

/** 候选列表：先看常用字段名，再看其他数组；字符串数组只认“一种……”开头的题目。 */
function pointItems(data: LooseRecord): LooseRecord[] {
  const named = LIST_KEYS.map((key) => data[key]);
  const others = Object.entries(data)
    .filter(([key]) => !LIST_KEYS.includes(key) && !NON_POINT_KEYS.has(key))
    .map(([, value]) => value);
  for (const list of [...named, ...others]) {
    if (!Array.isArray(list)) continue;
    const items = list
      .map((item): unknown => (typeof item === "string" && /^\s*一种/.test(item) ? { title: item.trim() } : item))
      .filter(isRecord);
    if (items.some((item) => titleOf(item))) return items;
  }
  return [];
}

/** 最后一道兜底：JSON 残缺或被截断时，直接从 "title": "一种……" 里取题目。 */
function quotedCandidates(text: string, visible: string): { visible: string; points: AutoPoint[]; recommended: number } {
  const titles: string[] = [];
  for (const match of text.matchAll(/"(?:title|name|题目|发明名称)"\s*:\s*"(一种[^"\n]{4,80})"/g)) {
    const title = match[1].trim();
    if (!titles.includes(title)) titles.push(title);
    if (titles.length >= 5) break;
  }
  const number = Number(text.match(/"(?:recommended|recommend|best)"\s*:\s*(\d{1,2})/)?.[1]);
  const recommended = Number.isInteger(number) && number >= 1 && number <= titles.length ? number - 1 : 0;
  return { visible, points: titles.map((title) => ({ title, problem: "", feature: "", effect: "", pending: "" })), recommended };
}

/**
 * 从选题回复里取可见正文、候选题目和模型推荐的序号（0 起）。
 * 依次尝试：json 代码块（容忍注释和多余逗号）→ 整段裸 JSON → 正文编号列表 → 残缺 JSON 里的 "title": "一种……"。
 */
export function parseAutoReply(text: string): { visible: string; points: AutoPoint[]; recommended: number } {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  let data: LooseRecord | null = null;
  for (let index = blocks.length - 1; index >= 0 && !data; index -= 1) data = looseJson(blocks[index][1]);
  // 去掉完整代码块，以及被截断、没有收尾围栏的 json 块，不把半截 JSON 展示给发明人。
  let visible = text
    .replace(/```(?:json)?\s*[\s\S]*?```/gi, "")
    .replace(/```(?:json)?\s*[{[][\s\S]*$/i, "")
    .trim();
  if (!data && !blocks.length && /^\s*[{[]/.test(text)) {
    data = looseJson(text);
    if (data) visible = "";
  }
  if (!data) {
    const prose = proseCandidates(visible);
    return prose.points.length ? prose : quotedCandidates(text, visible);
  }
  if (!visible && str(data.reply)) visible = str(data.reply);
  const raw = pointItems(data);
  const points = raw
    .map((item) => ({
      title: titleOf(item),
      problem: str(item.problem ?? item["技术问题"]),
      feature: str(item.feature ?? item.solution ?? item["核心特征"]),
      effect: str(item.effect ?? item["技术效果"]),
      pending: str(item.pending),
    }))
    .filter((item) => item.title);
  const flagged = raw.filter((item) => titleOf(item)).findIndex((item) => item.recommended === true);
  const number = Number(data.recommended ?? data.recommend ?? data.best ?? data["推荐"]);
  const recommended = Number.isInteger(number) && number >= 1 && number <= points.length ? number - 1 : flagged >= 0 && flagged < points.length ? flagged : 0;
  if (!points.length) {
    const prose = proseCandidates(visible);
    if (prose.points.length) return prose;
    const quoted = quotedCandidates(text, visible);
    if (quoted.points.length) return quoted;
  }
  return { visible, points, recommended };
}
function pickExistingIdea(ideas: AutoInput["ideas"]): AutoPoint | undefined {
  const list = (ideas ?? []).filter((idea) => idea.title.trim() && idea.status !== "dropped" && idea.status !== "rejected");
  const idea = list.find((item) => item.status === "pursued") ?? list[0];
  if (!idea) return undefined;
  return { title: idea.title.trim(), problem: idea.problem ?? "", feature: idea.feature ?? "", effect: idea.effect ?? "", pending: idea.pending ?? "" };
}

/** 发明人自己的交底材料（不计自动生成的大纲和选题说明）够不够直接成稿。 */
export function hasOwnMaterial(materials: readonly PackedMaterial[]): boolean {
  const chars = materials
    .filter((item) => item.name !== OUTLINE_MATERIAL_NAME && item.name !== AUTO_TOPIC_MATERIAL_NAME)
    .reduce((sum, item) => sum + item.text.replace(/\s+/g, "").length, 0);
  return chars >= 120;
}

function historyTopic(history: readonly ChatMessage[] | undefined): string {
  for (const message of [...(history ?? [])].reverse()) {
    if (message.role !== "user") continue;
    const topic = createTopic(parseSlash(message.text).rest || message.text);
    if (topic) return topic;
  }
  return "";
}

function createRequest(topic: string, userText: string): string {
  return [
    topic ? `我想写一件「${topic}」方向的发明专利。` : "",
    `【用户原始要求】${clipText(userText, 3000)}`,
    "候选题目必须围绕用户指定的技术主题；完整、全套、详细等词是输出要求，不是技术领域，不得据此更换主题。",
    "请联网换角度检索该领域的专利、论文和行业痛点，归纳现有做法和缺陷，给出 3 到 5 个候选发明题目。",
    '在结尾的 json 里用 "recommended" 写你最推荐的题目序号（从 1 开始），questions 留空。',
    "",
    AUTO_DIRECTIVE,
  ].join("\n");
}

function outlineRequest(point: AutoPoint): string {
  return [
    `请以「${point.title}」为题设计完整的大纲目录：技术方案、权利要求布局、附图清单和实施例安排。`,
    point.problem ? `技术问题：${point.problem}` : "",
    point.feature ? `核心特征：${point.feature}` : "",
    point.effect ? `预期效果：${point.effect}` : "",
    "",
    AUTO_DIRECTIVE,
    "- 大纲末尾不要列“需要发明人确认的问题”，改写成“默认假设（可后续修改）”；附图清单不少于 7 幅且类型多样，逐幅写明图号、图名、类型和要画的主要内容：方法类一般包括方法总流程图、2 幅关键步骤的细化流程图、系统框图、系统分层架构图、模块交互时序图、参数或效果曲线图、电子设备结构框图；装置/结构类一般包括整体结构示意图、剖视图、局部放大图、控制系统框图和工作流程图。",
    "- 材料中有《查新对比报告》时，大纲的权利要求布局必须把报告列出的区别技术特征写进权利要求1，并在“创新点”一节逐条对应。",
  ]
    .filter((line, index, all) => line || all[index - 1])
    .join("\n");
}

/** 选题回复解析不出题目时的追问：不再检索，只要一个候选题目 json 代码块。 */
export function candidatesOnlyRequest(): string {
  return `上一条回复没有给出结构化的候选题目。请不要再检索，也不要写任何其他文字，只输出一个 json 代码块，格式如下：
{"candidates":[{"title":"一种……","problem":"要解决的技术问题","feature":"核心技术特征","effect":"预期技术效果"}],"recommended":1}
- candidates 给 3 到 5 个，title 必须以“一种”开头，写成可以直接作为发明名称的完整题目；
- 只根据上一条回复和已有检索线索归纳，不得编造专利号、网址或实验数据；
- recommended 写最推荐题目的序号（从 1 开始）。`;
}

/** 选题回复中途失败（停顿、超时、断线）时值得再追问一次；密钥、鉴权、余额类失败追问也不会成功。 */
export function canRetryTopicFailure(detail: string): boolean {
  return !/(密钥|鉴权|未授权|无权|权限|余额|欠费|401|402|403|unauthori[sz]ed|forbidden|payment required|api[ _-]?key)/i.test(detail || "");
}

function clueLines(clues: AutoClue[]): string {
  return clues
    .slice(0, 20)
    .map((clue) => `[${clue.n}] ${clipText(clue.title || clue.url, 80)} ${clue.url}`.trim())
    .join("\n");
}

/** 首轮选题在收尾时中断：附上已经检索到的线索（只有标题和网址），再要候选题目 JSON。 */
export function candidatesAfterFailureRequest(detail: string, clues: AutoClue[]): string {
  return [
    `上一轮检索后的归纳没有完成（${detail || "无返回"}）。`,
    clues.length
      ? `已检索到的线索（只有标题和网址，未核验，只作选题参考，不要当成已核验的对比文件）：\n${clueLines(clues)}`
      : "没有拿到可用的检索线索，请按该领域公开的常见技术痛点归纳。",
    candidatesOnlyRequest(),
  ].join("\n\n");
}

/** 追问并进最后一条用户消息，避免连续两条用户消息（部分协议不接受）。 */
function appendToLastUser(messages: ModelMessage[], extra: string): ModelMessage[] {
  const last = messages.at(-1);
  if (last?.role === "user") return [...messages.slice(0, -1), { role: "user", content: `${last.content}\n\n${extra}` }];
  return [...messages, { role: "user", content: extra }];
}

function topicMaterial(point: AutoPoint, selection: string): PackedMaterial {
  return {
    name: AUTO_TOPIC_MATERIAL_NAME,
    kind: "text",
    text: [
      `题目：${point.title}`,
      `技术问题：${point.problem || "（按领域常见痛点归纳）"}`,
      `核心特征：${point.feature || "（按题目展开）"}`,
      `预期效果：${point.effect || "（定性描述）"}`,
      "说明：本题目由全自动模式根据公开检索线索选定，检索结果未经核验；文中数值均为模拟值，待实验验证。",
      selection ? `\n选题阶段的检索归纳（线索）：\n${clipText(selection, 3000)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export async function runAutoPatent(input: AutoInput, deps: AutoDeps): Promise<AutoOutcome> {
  const { caseId, dispatch, signal } = input;
  const trace = (text: string) => dispatch({ type: "chat-note", caseId, role: "trace", text });
  const say = (text: string) => dispatch({ type: "chat-note", caseId, role: "assistant", text });
  const stopped = (outline = false): AutoOutcome => {
    say("已停止这一轮。");
    return { stage: "stopped", outline };
  };

  let materials = [...input.materials];
  const ownMaterial = hasOwnMaterial(materials);
  let chosen = pickExistingIdea(input.ideas);
  let outline = materials.some((item) => item.name === OUTLINE_MATERIAL_NAME && item.text.trim());
  const requestedTopic = createTopic(parseSlash(input.userText).rest || input.userText);
  const topic = requestedTopic || historyTopic(input.history);
  // A reference file is evidence, not the user's selected invention title.
  if (ownMaterial && topic) {
    chosen = chosen?.title === topic ? chosen : { title: topic, problem: "", feature: "", effect: "", pending: "" };
    if (requestedTopic) {
      materials = materials.filter(item => item.name !== NOVELTY_MATERIAL_NAME || item.text.includes(requestedTopic));
    }
  }

  trace(
    `${AUTO_TRACE_PREFIX}：${ownMaterial ? "按你给的材料" : chosen ? `沿用已有题目「${chosen.title}」` : "检索选题 → 自动采用推荐题目"} → 查新对比 → ${ownMaterial || outline ? "" : "设计大纲 → "}写完整申请文件 → 生成 Word。全程不再提问，未知数值用标注“${SIMULATED_MARK}”的模拟值。`,
  );

  // ① 选题
  let selection = "";
  let candidates: AutoPoint[] = [];
  if (!chosen && !ownMaterial) {
    trace("① 选题：联网检索该领域的专利、论文和行业痛点，归纳 3 到 5 个候选题目，自动采用最推荐的一个。");
    const messages = buildChatMessages({ materials, history: input.history ?? [], userText: createRequest(topic, input.userText), intent: "create", tools: true });
    const reply = await deps.ask(messages, "create", trace, signal);
    if (signal?.aborted || reply.aborted) return stopped();
    let parsed = reply.ok ? parseAutoReply(reply.text) : { visible: "", points: [] as AutoPoint[], recommended: 0 };
    selection = parsed.visible;
    if (parsed.visible) say(parsed.visible);
    let retryNote = "";
    const clues = reply.sources ?? [];
    if (!parsed.points.length && (reply.ok || canRetryTopicFailure(reply.detail))) {
      // 检索额度用完后的收尾回复常常只有归纳、没有结构化题目；收尾时模型也可能长时间停顿被中断。
      // 两种情况都不联网再追问一次，只要候选题目 JSON；中断时把已拿到的线索标题和网址带进去。
      trace(
        reply.ok
          ? `选题回复里没有识别出候选题目（模型回复 ${reply.text.trim().length} 字），不联网再追问一次，只要候选题目 JSON。`
          : `选题回复中断（${reply.detail || "无返回"}），带上已检索到的 ${clues.length} 条线索，不联网再追问一次，只要候选题目 JSON。`,
      );
      if (!reply.ok && clues.length && !selection) selection = `检索线索（未核验）：\n${clueLines(clues)}`;
      const followUp: ModelMessage[] = reply.ok
        ? [...messages, { role: "assistant", content: reply.text }, { role: "user", content: candidatesOnlyRequest() }]
        : appendToLastUser(messages, candidatesAfterFailureRequest(reply.detail, clues));
      // outline 意图不带工具、只走一步，正好用来做只要 JSON 的追问。
      const retry = await deps.ask(followUp, "outline", trace, signal);
      if (signal?.aborted || retry.aborted) return stopped();
      const again = retry.ok ? parseAutoReply(retry.text) : null;
      if (again && again.points.length) {
        parsed = { ...again, visible: parsed.visible };
      } else {
        retryNote = retry.ok ? `；追问后仍没有（回复 ${retry.text.trim().length} 字）` : `；追问失败（${retry.detail || "无返回"}）`;
      }
    }
    if (parsed.points.length) {
      dispatch({ type: "merge-ideas", caseId, ideas: parsed.points });
      chosen = parsed.points[parsed.recommended] ?? parsed.points[0];
      candidates = parsed.points;
      dispatch({ type: "pursue-idea", caseId, title: chosen.title });
      trace(`已自动采用推荐题目「${chosen.title}」（共 ${parsed.points.length} 个候选，其余保留在候选列表里，可以随时改选重写）。`);
    } else if (topic || parsed.visible) {
      const title = topic || clipText(input.userText, 30);
      chosen = { title, problem: "", feature: "", effect: "", pending: "" };
      trace(`选题阶段没有整理出结构化的候选题目${reply.ok ? `（模型回复 ${reply.text.trim().length} 字，没有识别出“一种……”式的题目${retryNote}）` : `（${reply.detail || "无返回"}${retryNote}）`}，直接以「${title}」为主题继续。`);
      if (reply.ok) trace(`选题阶段模型原始回复（节选）：${clipText(reply.text.trim(), 300)}`);
    } else {
      say(`全自动成稿没能开始：选题检索没有返回内容（${reply.detail || "无返回"}）。可以再发一次，或换一个能联网的模型。`);
      return { stage: "failed", outline: false };
    }
  }

  // ①½ 查新对比：先多角度检索中国专利、逐项比对技术特征，确认方案有创新空间再写大纲和全文；
  //     风险为中或高时按未公开的技术手段强化方案（或换下一个候选题目）后复查。发明人自带交底材料时只出报告和改进建议，不替换方案。
  let noveltyArt: PriorArtRef[] = [];
  const corpusTitle = ownMaterial ? titleFromMaterials(materials, materials.map((item) => item.text).join("\n")) : "";
  const noveltyTarget: AutoPoint | undefined = chosen ?? (topic || corpusTitle ? { title: topic || corpusTitle, problem: "", feature: "", effect: "", pending: "" } : undefined);
  if (noveltyTarget?.title.trim() && !materials.some((item) => item.name === NOVELTY_MATERIAL_NAME && item.text.trim())) {
    trace("①½ 查新对比：按题目、核心特征和技术问题多角度检索中国专利，逐项比对技术特征、评估新颖性和创造性风险；风险高时自动强化方案或换候选题目后复查，确认有创新空间再写全文。");
    const targetTitle = noveltyTarget.title;
    const novelty = await runNoveltyCheck(
      { point: noveltyTarget, alternatives: candidates.filter((item) => item.title !== targetTitle), allowRewrite: !ownMaterial, trace, signal },
      deps.draft,
    );
    if (signal?.aborted || novelty.aborted) return stopped();
    noveltyArt = novelty.refs;
    if (novelty.report) {
      const saved: PackedMaterial = { name: NOVELTY_MATERIAL_NAME, kind: "text", text: novelty.report };
      materials = [...materials.filter((item) => item.name !== NOVELTY_MATERIAL_NAME), saved];
      dispatch({ type: "attach-materials", caseId, materials: [saved], replaceNamed: true });
    }
    if (!ownMaterial && novelty.changed) {
      chosen = novelty.point;
      dispatch({ type: "merge-ideas", caseId, ideas: [novelty.point] });
      dispatch({ type: "pursue-idea", caseId, title: novelty.point.title });
    }
    say(noveltySummary(novelty));
  }

  if (chosen && !ownMaterial) {
    const picked = topicMaterial(chosen, selection);
    materials = [...materials.filter((item) => item.name !== AUTO_TOPIC_MATERIAL_NAME), picked];
    dispatch({ type: "attach-materials", caseId, materials: [picked], replaceNamed: true });
  }

  // ② 大纲
  if (chosen && !ownMaterial && !outline) {
    trace(`② 大纲：按「${chosen.title}」写技术方案、权利要求布局、附图清单和实施例安排。`);
    const messages = buildChatMessages({ materials, history: [], userText: outlineRequest(chosen), intent: "outline", pursued: [chosen.title], chosenPoint: chosen });
    const reply = await deps.ask(messages, "outline", trace, signal);
    if (signal?.aborted || reply.aborted) return stopped();
    const text = reply.ok ? parseAutoReply(reply.text).visible : "";
    if (text.replace(/\s+/g, "").length >= 200) {
      say(text);
      const saved: PackedMaterial = { name: OUTLINE_MATERIAL_NAME, kind: "text", text };
      materials = [...materials.filter((item) => item.name !== OUTLINE_MATERIAL_NAME), saved];
      dispatch({ type: "attach-materials", caseId, materials: [saved], replaceNamed: true });
      outline = true;
      trace(`大纲已保存为《${OUTLINE_MATERIAL_NAME}》，接着按大纲写全文。`);
    } else {
      trace(`大纲没有写成（${reply.ok ? "内容太短" : reply.detail || "无返回"}），直接按题目写全文。`);
    }
  }

  // ③ 成稿（检索对比文件 → 全文 → 自检 → 必要时修订）
  trace("③ 成稿：按选题和大纲写完整的发明专利申请文件，写完自动自检并生成 Word。");
  const result: { draft?: InventionDraftState } = {};
  const capture: Dispatch<Action> = (action) => {
    if (action.type === "set-invention-draft") result.draft = action.draft;
    dispatch(action);
  };
  await runDraftTurn(
    {
      caseId,
      dispatch: capture,
      signal,
      materials,
      userText: `${AUTO_DRAFT_TEXT}\n\n【用户原始要求】${clipText(input.userText, 3000)}`,
      chosenPoint: chosen,
      pursued: chosen ? [chosen.title] : [],
      priorArt: noveltyArt.length ? noveltyArt : undefined,
      facts: input.facts ?? [],
    },
    { ...deps.draft, expand: true },
  );
  if (signal?.aborted) return { stage: "stopped", chosen, outline };
  const draft = result.draft;
  if (!draft) return { stage: "failed", chosen, outline };
  const simulated = (draft.text.match(/模拟值/g) ?? []).length;
  const finalTitle = draftTitle(draft.text) || chosen?.title || "";
  const unverified = unverifiedPatentNumbers(draft);
  if (unverified.length) trace(`专利号核对：${unverified.join("、")} 不在本次检索到的对比文件里，已在完成说明中提示核实。`);
  const app = parseApplication(draft.text, finalTitle);
  const report = formalCheck(app);
  const specNos = new Set((app.figureSpecs ?? []).map((spec) => spec.no));
  const drawn = app.figures.filter((figure) => specNos.has(figure.no)).length;
  const missing = app.figures.length - drawn;
  const figureLine = !app.figures.length
    ? "本稿没有附图"
    : missing
      ? `附图说明列出 ${app.figures.length} 幅，其中 ${drawn} 幅按附图数据自动绘制，${missing} 幅缺少附图数据，正式文件中为空白虚线框，需按附图说明补绘`
      : `附图说明列出的 ${app.figures.length} 幅图均已按附图数据自动绘制`;
  const titleNote = chosen?.title && finalTitle && chosen.title !== finalTitle ? `（成稿时由选题「${chosen.title}」调整而来）` : "";
  const exportLine = report.exportable
    ? "Word（.docx）在申请文件卡片里，可以分件下载或一键打包。"
    : `导出前形式核查没有通过，暂时不能生成 Word：${report.fatal}`;
  say(
    [
      `全自动成稿完成：${finalTitle ? `题目「${finalTitle}」${titleNote}，` : ""}${outline ? "已按《创作大纲.md》" : "已按材料"}写成 ${draft.claimCount} 项权利要求的完整申请文件，自检 ${draft.score} 分。${exportLine}`,
      `${simulated ? `文中 ${simulated} 处标注“${SIMULATED_MARK}”的数字是建议值，不是实测数据，正式 Word 中不带该标注，清单列在内部审核单里；` : ""}${figureLine}；对比文件和选题依据是公开检索线索，提交前请到国家知识产权局系统核实。`,
      unverified.length
        ? `文中 ${unverified.length} 个专利号（${unverified.slice(0, 5).join("、")}${unverified.length > 5 ? " 等" : ""}）不在本次检索到的对比文件里，可能是模型凭记忆写的，提交前必须逐一核实，查不到就删除。`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  );  return { stage: "draft", chosen, outline, draft };
}
