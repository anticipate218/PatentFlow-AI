/**
 * 中国发明专利申请文件（CNIPA）的结构化表示与形式检查。
 *
 * invention-draft.ts 管“写得好不好”（实质自检打分），这里管“是不是一份格式合规、能交给代理师的申请文件”：
 *   - parseApplication：把 Markdown 草稿拆成 说明书摘要 / 摘要附图 / 权利要求书 / 说明书（五部分）/ 说明书附图；
 *   - formalCheck：参照《专利审查指南》对说明书、权利要求书和摘要的形式要求，逐项给出 error / warn。
 * Word 导出（export-docx.ts）和知识库样例都复用这里的结构。
 * 检查只覆盖机器能判断的形式问题，不代表国家知识产权局会受理，也不替代专利代理师审核。
 */
import { claimRefNumbers, parseClaims } from "./invention-draft.ts";
import { auditFormulas, groupFormulaIssues } from "./formula-audit.ts";
import type { FormulaReport, FormulaSource } from "./formula-audit.ts";
import { joinDisplayBlocks, parseDisplayLine, plainParagraph } from "./formula.ts";
import { extractFigureSpecs, stripDraftJsonTail } from "./figure-spec.ts";
import type { FigureSpec, FigureSpecIssue } from "./figure-spec.ts";
import { auditFigures, parseReferenceList } from "./figure-audit.ts";
import type { FigureAuditResult, ReferenceEntry } from "./figure-audit.ts";
import { renderedFiguresOf } from "./figure-assets.ts";
import { stripInternalMarkers, formalizePendingMarks, findForbiddenMarkers } from "./draft-polish.ts";
import { formalizeSimulationAnnotations } from "./review-annotations.ts";

export const DESCRIPTION_HEADINGS = ["技术领域", "背景技术", "发明内容", "附图说明", "具体实施方式"] as const;
export type DescriptionHeading = (typeof DESCRIPTION_HEADINGS)[number];

export interface AppParagraph {
  text: string;
  /** A sub-heading inside a part (### 实施例1, ### 技术方案): printed bold and not paragraph-numbered. */
  sub: boolean;
  /** A display formula line ($$ … $$（n）): exported as a centred Word equation with its number flush right. */
  formula?: { tex: string; label: string | null };
  /** The Markdown line as written, kept for table rows so the formula audit can read symbol tables. */
  raw?: string;
}

export interface DescriptionPart {
  heading: DescriptionHeading;
  paragraphs: AppParagraph[];
}

export interface AppClaim {
  no: number;
  lines: string[];
  refs: number[];
  independent: boolean;
}

export interface AppFigure {
  no: number;
  caption: string;
}

export interface ParsedApplication {
  title: string;
  abstract: string[];
  abstractFigure: number | null;
  claims: AppClaim[];
  description: DescriptionPart[];
  figures: AppFigure[];
  pendingMarks: string[];
  /** 草稿中“（推断，待确认）”“（模拟值，待实验验证）”一类审核标注（带所在句子）；正式文件中已去掉，只列入内部审核单。 */
  reviewAnnotations?: string[];
  /** 草稿中 ```附图 代码块给出的结构化绘图数据（按图号排序）；代码块本身不进入说明书正文。 */
  figureSpecs?: FigureSpec[];
  /** 附图数据中无法识别或自相矛盾的地方。 */
  figureSpecIssues?: FigureSpecIssue[];
  /** “附图标记”列表：标记 → 部件名称。 */
  references?: ReferenceEntry[];
}

export type CheckLevel = "error" | "warn" | "ok";

export interface FormalCheck {
  id: string;
  label: string;
  level: CheckLevel;
  detail: string;
}

export interface FormalStats {
  titleChars: number;
  abstractChars: number;
  claimCount: number;
  independentCount: number;
  descriptionChars: number;
  figureCount: number;
  pendingCount: number;
}

export interface FormalReport {
  checks: FormalCheck[];
  errors: number;
  warnings: number;
  exportable: boolean;
  fatal: string;
  stats: FormalStats;
  /** 公式与符号一致性检查的完整结果（草稿中有公式时）。 */
  formulas?: FormulaReport;
  /** 附图核查的完整结果（草稿给出附图数据时）。 */
  figureAudit?: FigureAuditResult;
}

export const TITLE_SOFT_LIMIT = 25;
export const TITLE_HARD_LIMIT = 40;
export const ABSTRACT_LIMIT = 300;

const PROMO_WORDS = ["国际领先", "国内领先", "国际先进", "国内首创", "填补国内空白", "填补空白", "革命性", "划时代", "独一无二", "世界一流", "最先进"];
const CLAIM_VAGUE = ["例如", "最好是", "尤其是", "必要时", "等等", "或类似物", "大约", "接近于"];
const NUMERIC_APPROX = /\d[\d.]*\s*[A-Za-z%‰℃°μ个次秒分钟小时天倍]*\s*(?:左右|上下)/;
const CLAIM_FIGURE_REF = /如图|图\s*\d+\s*所示|附图\s*\d|如说明书/;
const DESCRIPTION_CLAIM_REF = /如权利要求\s*\d|权利要求\s*\d+\s*(?:所述|中任一)/;

export function countChars(text: string): number {
  return text.replace(/\s/g, "").length;
}

/** Formulas ($…$, $$…$$, \(…\), \[…\]) are shielded from the markdown clean-up and put back verbatim. */
const MATH_SHIELD = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<!\\)\$(?!\$)[^$\n]+?(?<!\\)\$/g;

/** Strip inline markdown so the Word file carries plain text. LaTeX formulas are kept exactly as written. */
export function cleanInline(line: string): string {
  const kept: string[] = [];
  const shielded = line.replace(MATH_SHIELD, (math) => {
    kept.push(math);
    return `\uE000${kept.length - 1}\uE001`;
  });
  return shielded
    .replace(/^\s{0,3}#{1,6}\s*/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*[-*+]\s+(?=\S)/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\uE000(\d+)\uE001/g, (_match, index: string) => kept[Number(index)] ?? "");
}

/**
 * 审核标注的上下文是从句中截取的片段，截取点可能落在加粗或强调标记的中间（例如“**步骤S1：数据采集。** 田间……”
 * 以“。”断句后只剩闭合的“**”）。cleanInline 只能去掉成对标记，这里再去掉落单的 ** 与 __；公式内的字符原样保留。
 */
export function stripStrayEmphasis(text: string): string {
  const kept: string[] = [];
  const shielded = text.replace(MATH_SHIELD, (math) => {
    kept.push(math);
    return `\uE000${kept.length - 1}\uE001`;
  });
  return shielded
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\uE000(\d+)\uE001/g, (_match, index: string) => kept[Number(index)] ?? "");
}

/** Markdown body to printable paragraphs: drops fences, rules and table separators, keeps sub-headings flagged. */
export function markdownParagraphs(body: string): AppParagraph[] {
  const out: AppParagraph[] = [];
  let fence = false;
  for (const raw of joinDisplayBlocks(body).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (!line.trim()) continue;
    if (fence) {
      out.push({ text: line.trim(), sub: false });
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) continue;
    if (line.includes("|") && line.includes("-") && /^\s*\|?[\s:|-]+\|?\s*$/.test(line)) continue;
    const display = parseDisplayLine(line);
    if (display) {
      out.push({ text: line.trim(), sub: false, formula: display });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cleanInline).filter(Boolean);
      if (cells.length) out.push({ text: cells.join("　"), sub: false, raw: line.trim() });
      continue;
    }
    const sub = /^\s{0,3}#{3,6}\s*\S/.test(line);
    const text = cleanInline(line);
    if (text) out.push({ text, sub });
  }
  return out;
}

interface RawSection {
  head: string;
  body: string;
}

/** Sections at exactly `level` (## = 2); a body runs until the next heading of the same or a higher level. */
function splitLevel(text: string, level: number): RawSection[] {
  const out: RawSection[] = [];
  let current: { head: string; body: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const hit = /^(#{1,6})(?![#\d])\s*(\S.*)$/.exec(line);
    if (hit && hit[1].length <= level) {
      if (current) out.push({ head: current.head, body: current.body.join("\n").trim() });
      current = hit[1].length === level ? { head: hit[2].trim(), body: [] } : null;
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) out.push({ head: current.head, body: current.body.join("\n").trim() });
  return out;
}

function headMatches(head: string, name: string): boolean {
  const clean = head.replace(/[\s*:：]/g, "").replace(/^[一二三四五六七八九十\d]+[、.．]/, "");
  if (name === "摘要" && clean.startsWith("摘要附图")) return false;
  return clean.startsWith(name);
}

function findSection(text: string, names: string[]): string | null {
  for (const level of [2, 3]) {
    for (const section of splitLevel(text, level)) {
      if (names.some((name) => headMatches(section.head, name))) return section.body;
    }
  }
  return null;
}

/** Every figure number a text points at, with ranges such as “图1至图3” expanded. */
export function figureRefs(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/图\s*(\d{1,3})(?:\s*(?:-|~|～|至|到)\s*图?\s*(\d{1,3}))?/g)) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    for (let value = start; value <= end && value - start < 50; value += 1) found.add(value);
  }
  return [...found].sort((a, b) => a - b);
}

function parseFigures(paragraphs: AppParagraph[]): AppFigure[] {
  const found = new Map<number, string>();
  for (const paragraph of paragraphs) {
    for (const piece of paragraph.text.split(/[；;]/)) {
      const hit = /^\s*图\s*(\d{1,3})\s*(?:为|是|示出了?|表示|：|:|，|,)?\s*(.*?)\s*[。.]?\s*$/.exec(piece);
      if (hit && !found.has(Number(hit[1]))) found.set(Number(hit[1]), hit[2] ?? "");
    }
  }
  return [...found].sort((a, b) => a[0] - b[0]).map(([no, caption]) => ({ no, caption }));
}

/** “附图标记”小节标题（### 附图标记、### 附图标记说明）或以“附图标记：”开头的段落。 */
const REFERENCE_HEAD = /^附图标记(?:说明|列表)?(?:[:：]|$)/;

function referenceHead(paragraph: AppParagraph): boolean {
  return REFERENCE_HEAD.test(paragraph.text.replace(/\s/g, ""));
}

/**
 * 说明书各部分中属于“附图标记”列表的段落：### 附图标记 小标题之后、下一个小标题之前的段落，
 * 以及单独一段“附图标记：10—……；11—……”。附图说明一节不算。
 */
function referenceParagraphs(description: DescriptionPart[]): Set<AppParagraph> {
  const found = new Set<AppParagraph>();
  for (const part of description) {
    if (part.heading === "附图说明") continue;
    let inList = false;
    for (const paragraph of part.paragraphs) {
      if (paragraph.sub) {
        inList = referenceHead(paragraph);
        continue;
      }
      if (inList || referenceHead(paragraph)) found.add(paragraph);
    }
  }
  return found;
}

/** 附图标记列表：优先取“附图标记”小节（## 或 ###），否则取说明书中的“附图标记：……”段落。 */
function parseReferences(text: string, description: DescriptionPart[]): ReferenceEntry[] {
  const section = findSection(text, ["附图标记"]);
  const lines = section !== null
    ? markdownParagraphs(section).map((item) => item.text)
    : [...referenceParagraphs(description)].map((item) => item.text.replace(/^\s*附图标记(?:说明|列表)?\s*[:：]?\s*/, ""));
  const seen = new Set<string>();
  return parseReferenceList(lines.join("\n")).filter((entry) => {
    const key = `${entry.ref}\u0000${entry.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 审核用的行内标注：“（推断，待确认）”“（模拟值，待实验验证）”“（待确认）”以及句首的“待确认：”。
 * 这些是给代理师和发明人看的提示，不得出现在正式申请文件中：解析时从正文去掉，带所在句子收进内部审核单。
 * 【待发明人确认：……】一类缺项占位不在此列：解析时由 formalizePendingMarks 改写为正式表述，原文列入 pendingMarks，由内部审核单逐项列出。
 */
const REVIEW_ANNOTATION = /[（(][ \t]*(?:推断[ \t]*[，,、][ \t]*待确认|模拟值[ \t]*[，,、][ \t]*待实验验证|待确认)[ \t]*[）)]/g;
const REVIEW_PREFIX = /(^[ \t]*(?:[-*+][ \t]+|\d+[.、）)][ \t]*)?|[。；;！？!?])[ \t]*待确认[ \t]*[：:][ \t]*/gm;
const SENTENCE_MARKS = ["\n", "。", "；", "！", "？"];

/** 草稿中的审核标注（带所在句子），按出现顺序去重。 */
export function reviewAnnotationsOf(text: string): string[] {
  const hits: Array<{ at: number; context: string }> = [];
  for (const match of text.matchAll(REVIEW_ANNOTATION)) {
    const at = match.index ?? 0;
    const before = text.slice(Math.max(0, at - 80), at);
    const cut = Math.max(...SENTENCE_MARKS.map((mark) => before.lastIndexOf(mark)));
    hits.push({ at, context: stripStrayEmphasis(cleanInline(`${before.slice(cut + 1)}${match[0]}`)) });
  }
  const inlineMark = new RegExp(REVIEW_ANNOTATION.source);
  for (const { index: at, raw } of formalizeSimulationAnnotations(text).annotations) {
    // Standard bracketed labels were collected above; retain the original text of the other forms too.
    if (inlineMark.exec(raw)?.[0] === raw) continue;
    const before = text.slice(Math.max(0, at - 80), at);
    const cut = Math.max(...SENTENCE_MARKS.map((mark) => before.lastIndexOf(mark)));
    hits.push({ at, context: stripStrayEmphasis(cleanInline(`${before.slice(cut + 1)}${raw}`)) });
  }
  for (const match of text.matchAll(REVIEW_PREFIX)) {
    const at = (match.index ?? 0) + match[1].length;
    const rest = text.slice(at, at + 120);
    const stop = rest.search(/[\n。；！？]/);
    const sentence = stop >= 0 ? rest.slice(0, stop + 1) : rest;
    // 同一句里另有“（推断，待确认）”一类标注时，那一条已带上整句，不重复列出
    if (inlineMark.test(sentence)) continue;
    hits.push({ at, context: stripStrayEmphasis(cleanInline(sentence)) });
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits.sort((a, b) => a.at - b.at)) {
    if (!hit.context || seen.has(hit.context)) continue;
    seen.add(hit.context);
    out.push(hit.context);
  }
  return out;
}

/** 正式正文保留模拟数值的非实测限定和核验要求；原始审核标注另存。 */
export function stripReviewAnnotations(text: string): string {
  return formalizeSimulationAnnotations(text).text.replace(REVIEW_ANNOTATION, "").replace(REVIEW_PREFIX, "$1");
}
/** Parse a markdown draft (the /发明稿 output or a library sample) into the parts of a CNIPA filing. */
export function parseApplication(markdown: string, fallbackTitle = ""): ParsedApplication {
  // 内部检索/审核提示（如“【待检索补充对比文件】”）不属于申请文件：解析前去掉，导出、预览和形式核查都不再看到（代码块原样保留）。
  const figureData = extractFigureSpecs(stripInternalMarkers(markdown.replace(/\r\n/g, "\n")).text);
  const draftText = stripDraftJsonTail(figureData.text);
  const reviewAnnotations = reviewAnnotationsOf(draftText);
  const annotated = stripReviewAnnotations(draftText);
  // 缺项占位（【待发明人确认：……】【待填写】等）不得出现在正式文件中：正文改写为正式表述，原文保留在 pendingMarks 中供内部审核单列出，缺失的事实不会被静默丢弃。
  const pendingMarks = [...new Set(annotated.match(/【待[^】]*】/g) ?? [])];
  const text = formalizePendingMarks(annotated).text;
  const h1 = /^#(?![#\d])\s*(\S.*)$/m.exec(text);
  const rawTitle = h1?.[1] ?? findSection(text, ["发明名称"]) ?? fallbackTitle;
  const title = cleanInline(rawTitle.split("\n")[0] ?? "")
    .replace(/^发明名称\s*[:：]\s*/, "")
    .replace(/[。．.；;，,\s]+$/, "")
    .trim();

  let abstractFigure: number | null = null;
  const abstract: string[] = [];
  for (const paragraph of markdownParagraphs(findSection(text, ["说明书摘要", "摘要"]) ?? "")) {
    const figure = /摘要附图\s*(?:[:：]|为|是)?\s*图\s*(\d{1,3})/.exec(paragraph.text);
    if (figure) {
      abstractFigure = Number(figure[1]);
      continue;
    }
    abstract.push(paragraph.text);
  }
  if (abstractFigure === null) {
    const figure = /图\s*(\d{1,3})/.exec(findSection(text, ["摘要附图"]) ?? "");
    if (figure) abstractFigure = Number(figure[1]);
  }

  const claimBody = joinDisplayBlocks(findSection(text, ["权利要求书", "权利要求"]) ?? "").split("\n").map(cleanInline).join("\n");
  const claims = parseClaims(claimBody).map((claim) => ({
    no: claim.no,
    lines: claim.text.split("\n").map((line) => line.trim()).filter(Boolean),
    refs: claim.refs,
    independent: claim.independent,
  }));

  const description = DESCRIPTION_HEADINGS.map((heading) => ({ heading, paragraphs: markdownParagraphs(findSection(text, [heading]) ?? "") }));
  const figures = parseFigures(description.find((part) => part.heading === "附图说明")?.paragraphs ?? []);

  return {
    title,
    abstract,
    abstractFigure,
    claims,
    description,
    figures,
    pendingMarks,
    reviewAnnotations,
    figureSpecs: figureData.specs,
    figureSpecIssues: figureData.issues,
    references: parseReferences(text, description),
  };
}

function partText(app: ParsedApplication, heading: DescriptionHeading): string {
  return (app.description.find((part) => part.heading === heading)?.paragraphs ?? []).map((item) => item.text).join("\n");
}

function listNos(values: number[]): string {
  return values.map((value) => `第 ${value} 条`).join("、");
}

// ---------------------------------------------------------------------------
// 从属权利要求的撰写规定（《专利审查指南》第二部分第二章 3.3.2 节）与“所述”特征的引用基础。
// 只检查机器能可靠判断的写法；主题名称和引用基础按字面比对，只给“需注意”。

function claimText(claim: AppClaim): string {
  return claim.lines.join("");
}

/** 引用部分开头可出现的词：“根据”“如”“在”等，以及“前述”“以上”“任一项”一类不写编号的引用。 */
const REFERENCE_LEAD = String.raw`^\s*(?:根据|按照|依据|如|在|按)?\s*(?:前面|前述|上述|以上)?\s*(?:任一项|任意一项|任一)?\s*`;
/** 以引用其他权利要求开头（“根据权利要求1……”“在权利要求1所述的方法中”“根据前面任一项权利要求……”），而不是只在正文中提到。 */
const LEADS_WITH_REFERENCE = new RegExp(`${REFERENCE_LEAD}权利要求`);
const REFERENCE_PART = new RegExp(`${REFERENCE_LEAD}(权利要求[^，,：:；;。]*?)所(?:述|限定)的?`);
/** 少数译文没有“所述”：“根据权利要求1的方法”。 */
const REFERENCE_PART_PLAIN = new RegExp(`${REFERENCE_LEAD}(权利要求[^，,：:；;。]*?)的`);
/** “所述”紧跟在引用部分之后（“权利要求1或2所述”“权利要求1至3中任一项所述”“前述权利要求中任一项所述”），不指代技术特征。 */
const REFERENCE_BEFORE_SUOSHU = /权利要求(?:[\d\s、,或者和及与以至到~～—–-]|权利要求)*(?:中的?)?(?:任一项|任意一项|任一|任意一|之一)?$/;
const ALTERNATIVE_REF = /或|任一|任意一|之一/;
const CUMULATIVE_REF = /\d\s*(?:和|以及|及|与|并且)\s*(?:权利要求\s*)?\d/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 开头的引用部分，例如“根据权利要求1或2所述的”“如权利要求1至3中的任意一项所述的”。refs 为从“权利要求”起的引用原文。 */
function referencePart(text: string): { whole: string; refs: string } | null {
  const hit = REFERENCE_PART.exec(text) ?? REFERENCE_PART_PLAIN.exec(text);
  return hit ? { whole: hit[0], refs: hit[1] } : null;
}

/** 主题名称：去掉引用部分、“一种”和附图标记后，到第一个逗号或“包括”为止；保留括号中的字母缩写（“起搏器(LCP)”）。 */
function claimSubject(text: string, part: { whole: string } | null): string {
  const flat = (part ? text.slice(part.whole.length) : text)
    .replace(/[（(]\s*\d[^（()）]*[）)]/g, "")
    .replace(/\s+/g, "")
    // 独立权利要求也可写作“一种权利要求1所述的涂料的施用方法”
    .replace(/^一种/, "")
    .replace(/^(?:(?:根据|按照|依据|如)?权利要求[^，,：:；;。]*?所(?:述|限定)的?)?(?:一种)?/, "");
  // 用途权利要求“……化合物在制备治疗××的药物中的用途”：主题到“用途”为止，即使中间有逗号
  const use = /^[^，,；;。]*?在制备[^；;。]*?中的(?:用途|应用)/.exec(flat)?.[0];
  if (use) return use;
  // 不在冒号处截断：“式(I)的化合物：或其药学上可接受的盐”的冒号后是结构式
  const stop = flat.slice(1).search(/[，,；;。]|还?包括|还?包含|其特征在于/);
  return (stop >= 0 ? flat.slice(0, stop + 1) : flat).replace(/中$/, "");
}

type SubjectKind = "product" | "method" | "use";

/** 主题名称的类别；“一种应用于雨水井的截污装置”以“装置”结尾，是产品。 */
function subjectKind(subject: string): SubjectKind {
  if (/(?:用途|应用|使用)$/.test(subject)) return "use";
  return /(?:方法|工艺|流程)$/.test(subject) ? "method" : "product";
}

/** a 中含有 b 的某个连续 size 字片段：“……材料应用于污水处理”与“……材料的制备方法”说的是同一对象。 */
function sharesTerm(a: string, b: string, size = 4): boolean {
  for (let start = 0; start + size <= b.length; start += 1) if (a.includes(b.slice(start, start + size))) return true;
  return false;
}

/** 比较主题名称时去掉“的”：“涂料的施用方法”与“涂料施用方法”相同。 */
function subjectKey(subject: string): string {
  return subject.replace(/的/g, "");
}

/** 并列的主题分开比较：“化合物或其药学上可接受的盐”分为“化合物”“其药学上可接受盐”。 */
function subjectPieces(subject: string): string[] {
  return subjectKey(subject)
    .split(/或者|或|以及|及|和|与/)
    .map((piece) => piece.replace(/^[^一-龥A-Za-z\d]+|[^一-龥A-Za-z\d]+$/g, ""))
    .filter(Boolean);
}

/**
 * 引用在前权利要求的另一类权利要求，例如“根据权利要求1所述的涂料的制备方法”“……化合物在制备药物中的用途”：
 * 类别（产品、方法、用途）与被引用的权利要求不同，名称中又含有被引用主题的中心词。实质上是另一项独立权利要求。
 */
function derivedCategory(own: { subject: string; kind: SubjectKind }, parent: { subject: string; kind: SubjectKind }): boolean {
  if (!own.subject || !parent.subject || own.kind === parent.kind) return false;
  const key = subjectKey(own.subject);
  return subjectPieces(parent.subject).some((piece) => key.includes(piece.slice(-2)) || sharesTerm(key, piece));
}

/** 重述的主题名称与被引用的一致：允许简称（“所述的方法”）和修饰语不同，中心词（末两字）须相同。 */
function sameSubject(own: string, parent: string): boolean {
  return subjectPieces(own).some((a) => subjectPieces(parent).some((b) => a.endsWith(b) || b.endsWith(a) || a.slice(-2) === b.slice(-2)));
}

interface ClaimNode {
  claim: AppClaim;
  /** 引用的在前权利要求：从属权利要求取引用部分，独立权利要求取其中提到的（“包括权利要求1所述的装置”）。 */
  parents: number[];
  subject: string;
  kind: SubjectKind;
  /** 独立权利要求，或引用在前权利要求的另一类权利要求：其后的从属权利要求以它为首。 */
  head: boolean;
  /** 引用两项以上权利要求的多项从属权利要求。 */
  multiple: boolean;
  /** 引用部分原文（如“权利要求1或2”），判断是否择一引用。 */
  reference: string;
  /** 引用部分没有重述主题名称（“根据权利要求1，其特征在于”）。 */
  unnamed: boolean;
  /** 引用部分没有写编号（“根据前述权利要求中任一项所述的”）。 */
  unnumbered: boolean;
}

function claimTree(claims: AppClaim[]): Map<number, ClaimNode> {
  const nodes = new Map<number, ClaimNode>();
  for (const claim of claims) {
    const text = claimText(claim);
    // 只在正文提到其他权利要求的（“空调器，……实现如权利要求1至34中任一项所述方法的步骤”）按独立权利要求处理
    const leads = !/^\s*一种/.test(text) && LEADS_WITH_REFERENCE.test(text);
    const part = leads ? referencePart(text) : null;
    const unnamed = leads && !part;
    const numbered = part ? claimRefNumbers(part.refs) : [];
    // “根据前述权利要求中任一项所述的”不写编号：引用前面各项
    const cited = !leads ? claim.refs : numbered.length ? numbered : claim.refs.length ? claim.refs : [...nodes.keys()];
    const parents = cited.filter((no) => no < claim.no && nodes.has(no));
    const subject = unnamed ? "" : claimSubject(text, part);
    const kind = subjectKind(subject);
    const head = !leads || parents.some((no) => {
      const parent = nodes.get(no);
      return parent !== undefined && derivedCategory({ subject, kind }, parent);
    });
    // 择一引用看整个引用部分（“根据前面任一项权利要求所述的”中“任一项”在“权利要求”之前）；
    // 没有标准引用部分时只看第一个分句，正文里的“或”“2和3个”不影响判断
    const reference = part?.whole ?? text.split(/[，,：:；;。]/)[0] ?? "";
    const unnumbered = part !== null && !numbered.length && !claim.refs.length;
    nodes.set(claim.no, { claim, parents, subject, kind, head, multiple: !head && parents.length >= 2, reference, unnamed, unnumbered });
  }
  return nodes;
}

/** 从属权利要求直接或间接从属的独立权利要求（含另一类权利要求）编号。 */
function rootsOf(no: number, nodes: Map<number, ClaimNode>, seen = new Set<number>()): Set<number> {
  const node = nodes.get(no);
  if (!node || seen.has(no)) return new Set();
  if (node.head) return new Set([no]);
  seen.add(no);
  const roots = new Set<number>();
  for (const parent of node.parents) for (const root of rootsOf(parent, nodes, seen)) roots.add(root);
  return roots;
}

/** 编号列表，连续三项以上写成范围：“3～10、12”。 */
function compactNos(values: number[]): string {
  const parts: string[] = [];
  for (let start = 0; start < values.length; start += 1) {
    let end = start;
    while (end + 1 < values.length && values[end + 1] === values[end] + 1) end += 1;
    parts.push(end - start >= 2 ? `${values[start]}～${values[end]}` : values.slice(start, end + 1).join("、"));
    start = end;
  }
  return parts.join("、");
}

/** “所述”后不构成特征名称的限定词：各、每个、多个、至少两个、相应等。 */
const TERM_QUANTIFIER = /^(?:各个?|每一?个?|任一|任意一?个?|全部|所有|多个|若干|至少[一二两三四五六七八九十\d]+个?|[一二两三四五六七八九十\d]+个|相应的?|对应的?)/;
/** 不检查的“所述”：公式符号、希腊字母、单字母变量、数字、步骤编号和代词。 */
const TERM_SKIP = /^(?:[$\\\u0370-\u03ff，,。；;：:、\d]|[A-Za-z](?![A-Za-z\d])|步骤|两者|二者|其|该|此)/;
/** 小写字母开头的多为公式变量（“所述wyi表示……”），不按特征名称检查。 */
const TERM_VARIABLE = /^[a-z]/;
/** 介词短语开头的“所述在步骤一的溶液中”：中心词在“的”之后。 */
const TERM_PREPOSITION = /^(?:在|由|从|对|经|按|将|于|通过|根据|当)[^，,。；;：:、]*?的(.+)$/;
const ORDINAL = /^第[一二三四五六七八九十\d]+/;
/** 常紧跟在单字名词后的字（连词、方位词和常见动词）：“所述轴上”“所述垫且”“所述酶选自”中名词只有一个字。 */
const AFTER_NOUN = new Set([..."与和及或且并的之上下内外中侧端处在为是由被设连固套位沿朝向于具包含选采呈供输接发进使形构分均都也又即则以通用经还可能将把对从至到时后前"]);

/**
 * 按字面判断“所述××”在前文中有没有在先表述：××开头两个字（单字名词一个字）、“第一××”的序数加一个字、
 * 字母缩写整体（“所述第一BSR”）出现在前文中，或××所带的附图标记在前文中出现过，即视为有引用基础。
 */
function hasAntecedent(term: string, available: string): boolean {
  // “所述无线检测器(1301)”：同一附图标记前的名称末两字与前文一致（“检测器(1301)”），即为同一部件
  const signed = /^([^，,。；;：:、（(]{1,12}?)[（(]\s*([A-Za-z0-9]+)\s*[）)]/.exec(term);
  if (signed && !signed[1].includes("所述")) {
    if (new RegExp(`${escapeRegExp(signed[1].slice(-2))}\\s*[（(]\\s*${signed[2]}\\s*[）)]`).test(available)) return true;
  }
  const ordinal = ORDINAL.exec(term)?.[0] ?? "";
  const rest = term.slice(ordinal.length);
  if (ordinal && /^[、，,和及与或]/.test(rest)) return available.includes(ordinal);
  const latin = /^[A-Za-z][A-Za-z0-9_-]*/.exec(rest)?.[0];
  if (latin) return available.includes(latin) && available.includes(ordinal);
  if (ordinal) return available.includes(term.slice(0, ordinal.length + 1));
  if (available.includes(term.slice(0, 2))) return true;
  const first = term[0] ?? "";
  if (AFTER_NOUN.has(term[1] ?? "") || /^.[，,。；;：:、（(\s]/.test(term)) return available.includes(first);
  // 单字名词后接动词（“以及-垫，所述垫布置在……”）：前文中该字两侧都是分隔，即单独作为名词出现过
  return new RegExp(`(?:^|[，,。；;：:、（(\\s\\-—和与及或个种的])${escapeRegExp(first)}(?=[，,。；;：:、（(\\s和与及或]|$)`, "m").test(available);
}

function termPreview(term: string): string {
  const cut = term.search(/[，,。；;：:、（(\s]/);
  const head = cut > 0 ? term.slice(0, cut) : term;
  return head.length > 6 ? `${head.slice(0, 6)}…` : head;
}

/** “所述××”在本项前文和所引用的权利要求中都找不到在先表述的地方，每项权利要求报第一处。 */
function antecedentGaps(nodes: Map<number, ClaimNode>): string[] {
  const all = [...nodes.values()];
  /** 本项提到的全部在前权利要求（含正文中的“所述系统是根据权利要求3所述的系统”），逐级上溯；“前述权利要求”一类不写编号的引用算前面各项。 */
  const ancestors = (node: ClaimNode, seen: Set<number>): Set<number> => {
    const unnumbered = !node.claim.refs.length && /权利要求/.test(claimText(node.claim));
    for (const no of unnumbered ? all.map((other) => other.claim.no) : node.claim.refs) {
      const parent = nodes.get(no);
      if (!parent || no >= node.claim.no || seen.has(no)) continue;
      seen.add(no);
      ancestors(parent, seen);
    }
    return seen;
  };
  const gaps: string[] = [];
  for (const node of all) {
    const text = claimText(node.claim);
    const earlier = [...ancestors(node, new Set())].map((no) => claimText((nodes.get(no) as ClaimNode).claim)).join("\n");
    for (const match of text.matchAll(/所述的?/g)) {
      const at = match.index ?? 0;
      const before = text.slice(0, at);
      // “根据权利要求1所述的”是引用部分，“如上所述”不指代特征
      if (REFERENCE_BEFORE_SUOSHU.test(before) || /[上前]$/.test(before)) continue;
      const term = text.slice(at + match[0].length).replace(TERM_QUANTIFIER, "");
      if (!term || TERM_SKIP.test(term) || TERM_VARIABLE.test(term)) continue;
      const available = `${earlier}\n${before}`;
      if (hasAntecedent(term, available)) continue;
      const inner = TERM_PREPOSITION.exec(term)?.[1];
      if (inner && hasAntecedent(inner.replace(TERM_QUANTIFIER, ""), available)) continue;
      gaps.push(`第 ${node.claim.no} 条“所述${termPreview(term)}”`);
      break;
    }
  }
  return gaps;
}

/** 多项从属权利要求、从属权利要求的位置与引用部分、“所述”特征的引用基础。 */
function claimStructureChecks(claims: AppClaim[]): FormalCheck[] {
  // 编号不连续或重复时引用关系无法可靠对应，先按“权利要求编号”一项修正
  if (!claims.every((claim, index) => claim.no === index + 1)) return [];
  const nodes = claimTree(claims);
  const all = [...nodes.values()];
  const dependents = all.filter((node) => !node.head);
  const checks: FormalCheck[] = [];
  const add = (id: string, label: string, level: CheckLevel, detail: string) => checks.push({ id, label, level, detail });
  const nosOf = (list: ClaimNode[]) => listNos(list.map((node) => node.claim.no));

  // 多项从属权利要求只能择一引用（“或”“任一项”），不得用“和”“及”并列引用
  const multiple = dependents.filter((node) => node.multiple);
  const cumulative = multiple.filter((node) => !ALTERNATIVE_REF.test(node.reference) && CUMULATIVE_REF.test(node.reference));
  const unclear = multiple.filter((node) => !ALTERNATIVE_REF.test(node.reference) && !cumulative.includes(node));
  const unclearNote = unclear.length
    ? `${nosOf(unclear)}引用两项以上权利要求但没有写明择一关系，建议写成“根据权利要求1或2所述的……”或“根据权利要求1至3中任一项所述的……”。`
    : "";
  if (cumulative.length) {
    add("claim-multiple", "多项从属权利要求择一引用", "error", `${nosOf(cumulative)}用“和”“及”等并列引用两项以上权利要求；多项从属权利要求只能择一引用，例如“根据权利要求1或2所述的……”。${unclearNote}`);
  } else {
    add("claim-multiple", "多项从属权利要求择一引用", unclear.length ? "warn" : "ok", unclearNote || (multiple.length ? `${nosOf(multiple)}均为择一引用` : "没有多项从属权利要求"));
  }

  // 多项从属权利要求不得作为另一项多项从属权利要求的引用基础（指南原文为“在后的多项从属权利要求不得引用在前的多项从属权利要求”，只查直接引用）
  const stacked = multiple.flatMap((node) => {
    const bases = node.parents.filter((no) => nodes.get(no)?.multiple);
    return bases.length ? [`第 ${node.claim.no} 条引用了同为多项从属权利要求的第 ${compactNos(bases)} 条`] : [];
  });
  add(
    "claim-multiple-basis",
    "多项从属权利要求的引用基础",
    stacked.length ? "error" : "ok",
    stacked.length
      ? `${stacked.join("；")}；多项从属权利要求不得作为另一项多项从属权利要求的引用基础。`
      : multiple.length ? "没有多项从属权利要求引用另一项多项从属权利要求" : "没有多项从属权利要求",
  );

  // 从属权利要求写在所从属的独立权利要求之后、下一项独立权利要求之前
  const misplaced = new Map<string, { nos: number[]; roots: number[]; nearest: number }>();
  for (const node of dependents) {
    const nearest = all.filter((other) => other.head && other.claim.no < node.claim.no).pop()?.claim.no;
    const roots = [...rootsOf(node.claim.no, nodes)];
    if (nearest === undefined || !roots.length || roots.includes(nearest)) continue;
    const key = `${roots.join(",")}|${nearest}`;
    const group = misplaced.get(key) ?? { nos: [], roots, nearest };
    group.nos.push(node.claim.no);
    misplaced.set(key, group);
  }
  add(
    "claim-order",
    "从属权利要求的位置",
    misplaced.size ? "warn" : "ok",
    misplaced.size
      ? `${[...misplaced.values()].map((group) => `第 ${compactNos(group.nos)} 条从属于第 ${group.roots.join("、")} 条，却写在另一项独立权利要求第 ${group.nearest} 条之后`).join("；")}；从属权利要求应写在所从属的独立权利要求之后、下一项独立权利要求之前。`
      : "均紧跟所从属的独立权利要求",
  );

  // 引用部分写明被引用权利要求的编号并重述其主题名称：允许简称，不允许换成别的主题（方法写成装置、装置写成系统）
  const referenceIssues = dependents.flatMap((node) => {
    const issues: string[] = [];
    if (node.unnumbered) issues.push(`第 ${node.claim.no} 条用“前述权利要求”一类写法，没有写明所引用权利要求的编号`);
    if (node.unnamed) issues.push(`第 ${node.claim.no} 条的引用部分没有写主题名称`);
    const parents = node.parents.map((no) => nodes.get(no)).filter((parent): parent is ClaimNode => Boolean(parent?.subject));
    const consistent = (parent: ClaimNode) => (node.kind === "use" && parent.kind === "use") || sameSubject(node.subject, parent.subject);
    if (node.subject && parents.length && !parents.some(consistent)) {
      issues.push(`第 ${node.claim.no} 条写作“${node.subject}”，所引用的第 ${parents.map((parent) => parent.claim.no).join("、")} 条为“${[...new Set(parents.map((parent) => parent.subject))].join("”“")}”`);
    }
    return issues;
  });
  add(
    "claim-reference",
    "从属权利要求的引用部分",
    referenceIssues.length ? "warn" : "ok",
    referenceIssues.length
      ? `${referenceIssues.slice(0, 3).join("；")}${referenceIssues.length > 3 ? `；另有 ${referenceIssues.length - 3} 项` : ""}；引用部分应写明所引用权利要求的编号并重述其主题名称，例如“根据权利要求1所述的……装置”。`
      : "写明了编号，主题名称与所引用的权利要求一致",
  );

  // “所述××”须在本项前文或所引用的权利要求中出现过，否则缺乏引用基础，保护范围不清楚
  const gaps = antecedentGaps(nodes);
  add(
    "claim-antecedent",
    "“所述”特征的引用基础",
    gaps.length ? "warn" : "ok",
    gaps.length
      ? `${gaps.slice(0, 5).join("、")}${gaps.length > 5 ? ` 等 ${gaps.length} 处` : ""}在本项前文和所引用的权利要求中没有出现，可能缺乏引用基础；请补充在先表述或统一用语。`
      : "“所述”指代的特征均有在先表述",
  );
  return checks;
}

/** The parsed application as formula-audit sources: the abstract, each claim, each part of the description. */
export function formulaSourcesOf(app: ParsedApplication): FormulaSource[] {
  const sources: FormulaSource[] = [];
  if (app.abstract.length) sources.push({ part: "说明书摘要", where: "说明书摘要", text: app.abstract.join("\n") });
  for (const claim of app.claims) sources.push({ part: "权利要求书", where: `权利要求${claim.no}`, text: claim.lines.join("\n") });
  for (const part of app.description) sources.push({ part: part.heading, where: part.heading, text: part.paragraphs.map((item) => item.raw ?? item.text).join("\n") });
  return sources;
}

/** 附图核查用的正文：技术领域至具体实施方式，不含附图说明和附图标记列表本身。 */
function figureBodyText(app: ParsedApplication): string {
  const list = referenceParagraphs(app.description);
  return app.description
    .filter((part) => part.heading !== "附图说明")
    .map((part) => part.paragraphs.filter((item) => !list.has(item) && !(item.sub && referenceHead(item))).map((item) => item.raw ?? item.text).join("\n"))
    .join("\n");
}

/** 草稿给出附图数据时的附图核查（图号、绘图数据、附图标记三方一致、步骤、图中文字、黑白与图幅）；没有附图数据时返回 null。 */
export function auditApplicationFigures(app: ParsedApplication): FigureAuditResult | null {
  const specs = app.figureSpecs ?? [];
  if (!specs.length) return null;
  return auditFigures({
    figures: app.figures,
    abstractFigure: app.abstractFigure,
    specs,
    rendered: renderedFiguresOf(app),
    specIssues: app.figureSpecIssues ?? [],
    referenceList: app.references ?? [],
    descriptionText: figureBodyText(app),
    claimsText: app.claims.map((claim) => claim.lines.join("\n")).join("\n"),
  });
}

/** 正式申请文件各部分（发明名称、摘要、权利要求、说明书、附图说明）中残留的内部占位与审核标记。 */
export function forbiddenMarkersOf(app: ParsedApplication): string[] {
  const parts = [
    app.title,
    ...app.abstract,
    ...app.claims.flatMap((claim) => claim.lines),
    ...app.description.flatMap((part) => part.paragraphs.map((item) => item.text)),
    ...app.figures.map((figure) => figure.caption),
  ];
  return findForbiddenMarkers(parts.join("\n"));
}

/** Formal completeness and layout checks for a parsed application. */
export function formalCheck(app: ParsedApplication): FormalReport {
  const checks: FormalCheck[] = [];
  const add = (id: string, label: string, level: CheckLevel, detail: string) => checks.push({ id, label, level, detail });

  // 发明名称
  const titleChars = countChars(app.title);
  if (!app.title) add("title", "发明名称", "error", "没有识别到发明名称（草稿首行应为“# 发明名称：……”）。");
  else if (titleChars > TITLE_HARD_LIMIT) add("title", "发明名称", "error", `${titleChars} 字，超过 ${TITLE_HARD_LIMIT} 字，需要压缩。`);
  else if (titleChars > TITLE_SOFT_LIMIT) add("title", "发明名称", "warn", `${titleChars} 字。一般不超过 ${TITLE_SOFT_LIMIT} 字，化学等特定领域可放宽到 ${TITLE_HARD_LIMIT} 字。`);
  else add("title", "发明名称", "ok", `${titleChars} 字`);
  if (/[®™©]|商标|型号/.test(app.title)) add("title-terms", "发明名称用语", "warn", "发明名称不应含商标、型号、人名地名等非技术用语。");

  // 摘要
  const abstractChars = countChars(app.abstract.map((text) => plainParagraph(text)).join(""));
  if (!abstractChars) add("abstract", "说明书摘要", "error", "没有摘要。");
  else if (abstractChars > ABSTRACT_LIMIT) add("abstract", "说明书摘要", "error", `${abstractChars} 字，超过 ${ABSTRACT_LIMIT} 字（含标点）。`);
  else add("abstract", "说明书摘要", "ok", `${abstractChars} 字`);

  if (!app.figures.length) {
    add("abstract-figure", "摘要附图", app.abstractFigure === null ? "ok" : "warn", app.abstractFigure === null ? "说明书没有附图，无需摘要附图。" : "说明书没有附图，却指定了摘要附图。");
  } else if (app.abstractFigure === null) {
    add("abstract-figure", "摘要附图", "warn", `未指定摘要附图，导出时默认使用图${app.figures[0].no}；应选最能说明技术方案的一幅。`);
  } else if (!app.figures.some((figure) => figure.no === app.abstractFigure)) {
    add("abstract-figure", "摘要附图", "error", `摘要附图指定为图${app.abstractFigure}，但附图说明里没有这幅图。`);
  } else {
    add("abstract-figure", "摘要附图", "ok", `图${app.abstractFigure}`);
  }

  // 权利要求书
  const independents = app.claims.filter((claim) => claim.independent);
  if (!app.claims.length) {
    add("claims", "权利要求书", "error", "没有识别到权利要求。");
  } else {
    add("claims", "权利要求书", "ok", `共 ${app.claims.length} 项，独立权利要求 ${independents.length} 项`);
    const sequential = app.claims.every((claim, index) => claim.no === index + 1);
    add("claim-numbering", "权利要求编号", sequential ? "ok" : "error", sequential ? "从 1 起连续编号" : "编号不连续或重复，应以阿拉伯数字顺序编号。");

    const badRefs = app.claims.filter((claim) => !claim.independent && claim.refs.some((ref) => ref >= claim.no || ref < 1));
    add("claim-refs", "从属权利要求引用", badRefs.length ? "error" : "ok", badRefs.length ? `${listNos(badRefs.map((claim) => claim.no))}引用了在后或不存在的权利要求。` : "只引用在前的权利要求");

    const multiSentence = app.claims.filter((claim) => {
      const joined = claim.lines.join("");
      return !/。$/.test(joined) || joined.slice(0, -1).includes("。");
    });
    add("claim-sentence", "每项权利要求一句话", multiSentence.length ? "warn" : "ok", multiSentence.length ? `${listNos(multiSentence.map((claim) => claim.no))}中间出现句号或未以句号结尾。` : "只在结尾使用句号");

    const figureInClaims = app.claims.filter((claim) => CLAIM_FIGURE_REF.test(claim.lines.join("")));
    add("claim-figure", "权利要求不引用附图和说明书", figureInClaims.length ? "error" : "ok", figureInClaims.length ? `${listNos(figureInClaims.map((claim) => claim.no))}使用了“如图……所示”或“如说明书……所述”。` : "未引用附图或说明书");

    const vague = app.claims.filter((claim) => {
      const joined = claim.lines.join("");
      return CLAIM_VAGUE.some((word) => joined.includes(word)) || NUMERIC_APPROX.test(joined);
    });
    add("claim-clarity", "权利要求用语清楚", vague.length ? "warn" : "ok", vague.length ? `${listNos(vague.map((claim) => claim.no))}含“例如、最好是、大约、……左右”等使范围不清楚的用语。` : "未发现模糊用语");

    const onePart = independents.filter((claim) => !claim.lines.join("").includes("其特征在于"));
    add("claim-two-part", "独立权利要求两段式", onePart.length ? "warn" : "ok", onePart.length ? `${listNos(onePart.map((claim) => claim.no))}没有“其特征在于”，确认是否适合写成前序部分加特征部分。` : "前序部分 + 特征部分");

    // 多项从属权利要求、从属权利要求的位置与引用部分、“所述”特征的引用基础
    for (const check of claimStructureChecks(app.claims)) add(check.id, check.label, check.level, check.detail);
  }

  // 说明书
  const requiredParts: DescriptionHeading[] = ["技术领域", "背景技术", "发明内容", "具体实施方式"];
  const missingParts = requiredParts.filter((heading) => !partText(app, heading));
  add("description-parts", "说明书组成部分", missingParts.length ? "error" : "ok", missingParts.length ? `缺少：${missingParts.join("、")}` : "技术领域、背景技术、发明内容、具体实施方式齐全");

  const bodyText = app.description.filter((part) => part.heading !== "附图说明").map((part) => part.paragraphs.map((item) => item.text).join("\n")).join("\n");
  const refs = figureRefs(bodyText);
  const listed = app.figures.map((figure) => figure.no);
  if (!app.figures.length) {
    add("figures", "附图说明", refs.length ? "error" : "ok", refs.length ? `正文提到图${refs.join("、图")}，但没有附图说明。` : "无附图（确认方案确实不需要图示）");
  } else {
    const unlisted = refs.filter((no) => !listed.includes(no));
    const unused = listed.filter((no) => !refs.includes(no));
    const continuous = listed.every((no, index) => no === index + 1);
    if (unlisted.length) add("figures", "附图引用一致", "error", `正文提到图${unlisted.join("、图")}，附图说明里没有。`);
    else if (unused.length) add("figures", "附图引用一致", "warn", `图${unused.join("、图")}在具体实施方式中没有被说明。`);
    else add("figures", "附图引用一致", "ok", `共 ${listed.length} 幅，正文均有引用`);
    if (!continuous) add("figure-numbering", "附图编号", "warn", `附图编号为图${listed.join("、图")}，应从图1起连续编号。`);
  }

  // 附图：有附图数据时逐幅核查；图号连续性已在上面检查，不重复列出
  const figureAudit = auditApplicationFigures(app);
  if (figureAudit) {
    for (const check of figureAudit.checks) if (check.id !== "figure-numbering") add(check.id, check.label, check.level, check.detail);
  } else if (app.figures.length) {
    add("figure-data", "附图绘制数据", "warn", `草稿没有附图绘图数据，图${app.figures.map((figure) => figure.no).join("、图")}在 Word 中为占位，需按附图说明用黑色线条绘制后替换；重新生成草稿可得到自动绘制的附图。`);
  }

  add("description-claim-ref", "说明书不引用权利要求", DESCRIPTION_CLAIM_REF.test(bodyText) ? "warn" : "ok", DESCRIPTION_CLAIM_REF.test(bodyText) ? "说明书中出现“如权利要求……所述”一类引用语，应改为直接写明技术内容。" : "未发现");

  const promo = PROMO_WORDS.filter((word) => bodyText.includes(word) || app.abstract.join("").includes(word));
  add("promo", "无商业宣传用语", promo.length ? "warn" : "ok", promo.length ? `出现：${promo.join("、")}` : "未发现");

  const embodimentChars = countChars(partText(app, "具体实施方式"));
  if (embodimentChars) add("embodiment-depth", "具体实施方式充分", embodimentChars < 800 ? "warn" : "ok", embodimentChars < 800 ? `仅 ${embodimentChars} 字，可能不足以使本领域技术人员实现。` : `${embodimentChars} 字`);

  // 公式与符号：权利要求书、说明书、摘要之间的一致性（草稿中有公式时才检查）
  const formulas = auditFormulas(formulaSourcesOf(app));
  if (formulas.applicable) {
    for (const group of groupFormulaIssues(formulas)) {
      const shown = group.details.slice(0, 3).join("；");
      add(group.id, group.label, group.level, group.level === "ok" ? "未发现问题" : group.details.length > 3 ? `${shown}；另有 ${group.details.length - 3} 处，见公式与符号一览` : shown);
    }
  }

  add("pending", "待补充事实", app.pendingMarks.length ? "warn" : "ok", app.pendingMarks.length ? `${app.pendingMarks.length} 处缺项在正式文件中已改写为“根据实际应用需求确定”“以实际测试记录为准”等概括表述，提交前须按内部审核单补充真实参数或数据。` : "无");
  const annotations = app.reviewAnnotations ?? [];
  if (annotations.length) {
    add("review-annotations", "推断与模拟值标注", "warn", `${annotations.length} 处“（推断，待确认）”“（模拟值，待实验验证）”一类标注已从正式文件中去掉，相应内容提交前须逐项核实，清单见内部审核单。`);
  }
  const forbidden = forbiddenMarkersOf(app);
  if (forbidden.length) add("forbidden-marks", "内部占位与审核标记", "error", `正式文件中仍有 ${forbidden.length} 处：${forbidden.slice(0, 5).join("、")}`);
  const descriptionChars = countChars(app.description.map((part) => part.paragraphs.map((item) => plainParagraph(item.text)).join("")).join(""));
  let fatal = "";
  if (!app.claims.length) fatal = "没有识别到权利要求书，无法按申请文件格式导出。请先用 /发明稿 生成完整草稿。";
  else if (!descriptionChars) fatal = "没有识别到说明书正文，无法按申请文件格式导出。";
  else if (figureAudit?.errorCount) {
    const figureErrors = figureAudit.checks.filter((check) => check.level === "error");
    const shown = figureErrors.slice(0, 3).map((check) => `${check.label}：${check.detail}`).join("；");
    fatal = `附图核查有 ${figureErrors.length} 项需修改，修改附图数据、附图说明或附图标记后再导出。${shown}${figureErrors.length > 3 ? `；另有 ${figureErrors.length - 3} 项` : ""}`;
  }
  if (!fatal && forbidden.length) {
    fatal = `正式文件中仍有内部占位或审核标记（${forbidden.slice(0, 5).join("、")}${forbidden.length > 5 ? ` 等 ${forbidden.length} 处` : ""}），已拦截导出；请重新成稿或删去这些标记后再导出。`;
  }

  return {
    checks,
    errors: checks.filter((item) => item.level === "error").length,
    warnings: checks.filter((item) => item.level === "warn").length,
    exportable: !fatal,
    fatal,
    formulas: formulas.applicable ? formulas : undefined,
    figureAudit: figureAudit ?? undefined,
    stats: {
      titleChars,
      abstractChars,
      claimCount: app.claims.length,
      independentCount: independents.length,
      descriptionChars,
      figureCount: app.figures.length,
      pendingCount: app.pendingMarks.length,
    },
  };
}

/** One line for a toast or chat note. */
export function reportSummary(report: FormalReport): string {
  if (!report.exportable) return report.fatal;
  if (!report.errors && !report.warnings) return "形式检查全部通过。";
  return `形式检查：${report.errors} 项需修改，${report.warnings} 项需注意，详见文末内部审核单。`;
}
