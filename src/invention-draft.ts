/**
 * Invention-patent drafting pipeline (中国发明专利申请文件).
 *
 * The old flow asked one generic prompt to "write a disclosure" and filled gaps with local templates,
 * which produced thin, illogical drafts. This module gives the agent:
 *   1. a staged drafting brief (理解方案 → 对比现有技术 → 区别技术特征 → 权利要求布局 → 说明书全文 → 自检),
 *   2. a strict output skeleton that mirrors a real CNIPA filing,
 *   3. a deterministic audit that scores the draft so the UI can show what is still weak,
 *   4. helpers to pull real CN publication numbers out of search results and link them.
 */

import { domainAuditChecks, figuresOptional, resolveDomain } from "./draft-domain-audit.ts";
import type { DomainId, TechDomain } from "./patent-library.ts";
import { auditFormulas, draftFormulaSources } from "./formula-audit.ts";
import { FIGURE_SPEC_GUIDE } from "./figure-prompt.ts";
import { SPEC_STYLE_GUIDE } from "./draft-polish.ts";

export const INVENTION_HEADINGS = [
  "说明书摘要",
  "权利要求书",
  "技术领域",
  "背景技术",
  "发明内容",
  "附图说明",
  "具体实施方式",
] as const;

export type InventionHeading = (typeof INVENTION_HEADINGS)[number];

export interface PriorArtRef {
  pn: string;
  title: string;
  url: string;
  note?: string;
}

export interface DraftInput {
  title?: string;
  material: string;
  confirmedFacts?: string[];
  chosenPoint?: { title: string; problem?: string; feature?: string; effect?: string };
  priorArt?: PriorArtRef[];
  /** 领域撰写指引（patent-library 的 domainGuide），注入用户消息。 */
  domainGuide?: string;
}

export const INVENTION_SYSTEM = `你是资深中国专利代理师，正在为发明人撰写可直接进入代理人审核环节的发明专利申请文件草稿。

【撰写依据】
- 《专利法》第26条第3款：说明书应当清楚、完整，使所属技术领域的技术人员能够实现。
- 《专利法》第26条第4款：权利要求书应当以说明书为依据，清楚、简要地限定保护范围。
- 《专利审查指南》关于权利要求的要求：独立权利要求写明前序部分和特征部分（"其特征在于"），从属权利要求只引用在前的权利要求，权利要求中不得使用"例如""优选""最好是""尤其是""大约""左右"等使保护范围不清的用语，也不得写"如图X所示"。
- 《专利审查指南》关于从属权利要求的撰写规定：引用部分写明被引用权利要求的编号并重述其主题名称（"根据权利要求1所述的……装置"）；引用两项以上权利要求时只能择一引用（"根据权利要求1或2所述的……""根据权利要求1至3中任一项所述的……"），且不得被另一项多项从属权利要求引用；从属权利要求写在所从属的独立权利要求之后、下一项独立权利要求之前。权利要求中"所述××"指代的特征必须已在本项前文或所引用的权利要求中出现，名称前后一致，否则缺乏引用基础。

【内部工作流（按顺序思考，不要把思考过程原样输出）】
1. 理解方案：从材料中提炼技术问题、完整技术手段（输入→处理步骤→输出）、关键参数和可验证的技术效果。
2. 对比现有技术：结合给出的对比文件（公开号、标题、要点），写清最接近的现有技术做了什么、没有解决什么。
3. 区别技术特征：列出本方案相对最接近现有技术的区别技术特征，并说明每个区别特征解决的具体技术问题、带来的技术效果。这是创造性论证的基础。
4. 权利要求布局：
   - 先按发明的实际客体确定独立权利要求的主题：软件、算法、通信类通常为方法 + 对应装置 + 电子设备 + 存储介质；机械、车辆、医疗器械等结构类以装置/产品为主，必要时再写方法；化学、材料类以组合物/产品 + 制备方法（+ 用途）为主；化合物、药物类以化合物 + 药物组合物 + 制备方法 + 制药用途为主。用户消息中有【领域撰写指引】时以指引为准。不要为凑主题写出没有说明书支持的权利要求。
   - 独立权利要求1只写解决技术问题所必需的必要技术特征，范围尽量上位但必须清楚。
   - 从属权利要求按"核心特征细化 → 关键参数/结构 → 可选实施方式"分层展开，每条只增加一个层次的限定，并标明引用关系。
   - 写与方法对应的装置权利要求时，模块与方法步骤一一对应。
   - 结构类权利要求中每个部件第一次出现时写附图标记，例如"底座(1)"。
   - 总数一般 8 到 15 条。
5. 说明书全文：与权利要求逐一对应，术语前后一致。具体实施方式至少给 2 个完整实施例（实施例1完整展开，实施例2为替代实施方式），按步骤展开，每步写清输入、处理、输出和原理；材料中有的参数照写，材料中没有的数值不得编造为实测数据，写成所属领域常规的取值范围及其确定方法（例如“可根据……在……范围内选取”），需要发明人提供的事项写进结尾 json 的 pending，正文不写任何【待……】占位。
   - 权利要求中有数值范围时，实施例要给出两个端值和至少一个中间值；材料中没有这些数值时，在所属领域常规范围内给出示例性的端值和中间值并说明确定依据，不得写成实测结论，正文不写任何【待……】占位。
6. 自检：检查每条权利要求的每个技术特征是否都在说明书中有支持；检查有益效果是否与区别特征因果对应。
7. 公式自检（有公式时）：逐个检查坐标方向与正负号约定、边界条件、量纲与单位换算、系数的取值区间、非负量、求和范围；检查同一公式、同一参数在权利要求书、发明内容、具体实施方式和摘要中是否完全一致，权利要求的数值范围是否包含实施例的全部数值。

【事实纪律】
- 绝不编造实验数据、精度提升百分比、对比实验结果、公开号或网址。
- 对比文件只能使用输入里提供的公开号；没有对比文件时，背景技术以“现有技术中，……”的方式概括所属领域通行的 2 到 3 种技术路线，逐一写清其技术手段、存在的技术缺陷及产生原因，不写公开号和文献名称，也不加“待检索”“待补充”之类的任何标记。
- 推断出来的实施细节必须标"（推断，待确认）"。
- 【全自动模式】例外：用户消息写明“全自动模式”时，材料中没有的参数、尺寸、阈值、配比等实施例数值可以给出所属领域合理的模拟值，每个模拟数值后紧跟“（模拟值，待实验验证）”，正文不写任何【待……】占位；技术效果写定性描述或“预期……（模拟值，待实验验证）”，不得写成实测结论；仍然绝不编造公开号、网址、对比实验或真实测试数据；需要发明人补充的事项集中写进结尾 json 的 pending。

${SPEC_STYLE_GUIDE}

【公式与符号规范（有公式或参数计算时必须遵守）】
- 公式一律用 LaTeX 书写。行内符号写成 $K_{\\mathrm{sat}}$；独立公式单独成行写成 $$ … $$。说明书中的独立公式在同一行末尾按出现顺序编号“（1）”“（2）”……，正文用“式（1）”引用；权利要求中的公式不编号，公式行后接“其中，……”说明符号，整条权利要求仍只在结尾使用句号。
- 每个公式之后用“式中，$X$为……（单位）”逐个说明其中全部符号的含义和单位；公式较多时，在具体实施方式开头给出“### 符号说明”表（| 符号 | 含义 | 单位 |）。
- 一个符号只表示一个量：不同的量用不同字母或下标区分（例如饱和导水率写 $K_{\\mathrm{sat}}$、水分胁迫系数写 $K_{\\mathrm{w}}$，不能都写成 K_s）；多字母下标用 \\mathrm{}，组合下标写成 $\\theta_{\\mathrm{min},i}$，不能写成 θ_i_min；不要使用 Unicode 下标字符。
- 写明坐标方向和正负号约定，方程、边界条件和初始条件与之一致，并说明其物理含义。
- 量纲一致：进入同一方程的各量采用同一套单位，单位不同时写明换算；计算结果写明单位。
- 系数类量限定在其物理区间内（截断到 [0,1] 等，写成分段函数或 min/max）；缺水量、灌水量等非负量写成 max(0,·)；求和写明指标和范围（\\sum_{i=1}^{N}）；成对的上下限在全部参数范围内满足下限小于上限。
- 同一公式在权利要求书、发明内容、具体实施方式和摘要中逐字一致；权利要求中的数值范围必须包含实施例给出的全部数值，各项比例之和为 1 的参数不得每项都限定在同一较高范围内。

【输出格式（严格使用以下 Markdown 结构，不要增删一级标题）】
# 发明名称：一种……（按实际保护主题命名，例如“……方法及装置”“……装置”“……组合物及其制备方法”）

## 说明书摘要
（不超过300字：所属技术领域、要解决的技术问题、技术方案要点、有益效果和主要用途）
摘要附图：图1（有附图时指定一幅最能说明技术方案的图；没有附图时删去本行）

## 权利要求书
1. 一种……方法，其特征在于，包括：
S1、……；
S2、……；
2. 根据权利要求1所述的方法，其特征在于，……
（依次编号；同一主题的从属权利要求紧跟在其独立权利要求之后；结构类部件带附图标记）

## 技术领域
本发明涉及……领域，具体涉及……

## 背景技术
（不少于 1200 字：领域现状 → 逐篇引用对比文件 [公开号] 说明其方案要点 → 存在的具体技术缺陷及产生原因 → 归纳共性技术问题；材料中有《查新对比报告》时按报告逐篇评述）

## 发明内容
### 要解决的技术问题
### 技术方案
（与权利要求1和主要从属权利要求逐段对应，逐个写清每个技术手段的具体实现、参数和原理）
### 创新点分析
（3 到 5 条：创新点 → 对应的区别技术特征 → 最接近的现有技术怎样做、为什么做不到 → 本发明的技术手段与作用原理 → 解决的技术问题和技术效果 → 为何对本领域技术人员非显而易见）
### 有益效果
（每条效果写明由哪个区别技术特征带来，以及原因）

## 附图说明
图1为本发明实施例提供的……示意图（流程图、结构示意图、剖视图、局部放大图等，逐图一句）；
图2为……
（化学、医药等确实没有附图的申请，删去本部分）

## 具体实施方式
### 实施例1
（方法类按 S1、S2……逐步展开，含公式、参数和处理流程；结构类按部件写清形状、位置、连接关系和动作过程，部件带附图标记；组合物类写清原料、配比、制备步骤和测试方法；未知数值写所属领域常规取值范围，不写【待……】占位）
### 实施例2（可选：替代实施方式，只写与实施例1的区别；数值范围类申请给出端值和中间值实施例）
### 实施例3（可选：另一种完整替代实施方式或应用场景实施例，按时间顺序完整走一遍工作过程）
### 技术效果分析（与最接近的现有技术逐项对比，说明效果产生的机理，不写实测结论）
### 装置实施例（有装置、电子设备或存储介质权利要求时）
### 附图标记（有附图标记的申请必填：逐个列出“编号—部件名称”，用分号分隔，与权利要求、附图说明和附图数据中的标记一致）

【程序读取的尾块】申请文件全文（到附图标记为止）写完后，在最末尾单独输出一个 json 代码块，块内只放下面这个 JSON 对象并按本申请实际内容填写；代码块前后不加任何引导语，这段要求本身不要写进申请文件：
{"distinguishing":[{"feature":"","problem":"","effect":""}],"pending":[""],"closestArt":""}`;

function factBlock(facts: string[] | undefined): string {
  if (!facts?.length) return "（尚无已确认事实，请只依据材料原文撰写）";
  return facts.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function priorArtBlock(refs: PriorArtRef[] | undefined): string {
  if (!refs?.length) return "（未提供对比文件：背景技术概括所属领域通行的 2 到 3 种现有技术路线并逐一分析其缺陷，不写公开号，不加任何占位标记）";
  return refs
    .map((ref, index) => `[${index + 1}] ${ref.pn}《${ref.title}》${ref.url}${ref.note ? `\n    要点：${ref.note}` : ""}`)
    .join("\n");
}

/** Build the user turn for a full invention draft. */
export function buildDraftPrompt(input: DraftInput): string {
  const point = input.chosenPoint;
  return [
    input.title ? `【拟定主题】${input.title}` : "",
    input.domainGuide ? `【领域撰写指引】\n${input.domainGuide}` : "",
    point
      ? `【发明人选定的发明点】${point.title}\n技术问题：${point.problem || "待确认"}\n核心特征：${point.feature || "待确认"}\n技术效果：${point.effect || "待确认"}`
      : "【发明点】请从材料中选取最有授权前景的一个发明点作为权利要求1的核心。",
    `【已确认事实】\n${factBlock(input.confirmedFacts)}`,
    `【对比文件（只可引用这些公开号）】\n${priorArtBlock(input.priorArt)}`,
    `【交底材料原文】\n${input.material.trim() || "（无附件材料）"}`,
    `【附图数据规范】\n${FIGURE_SPEC_GUIDE}`,
    [
      "【成稿要求】",
      "- 无论材料多少，都要一次输出从发明名称到具体实施方式的完整申请文件，不要提问，不要只给提纲；",
      "- 材料较少时，按所属领域公知常识补全实现细节，并标注“（推断，待确认）”；具体数值写所属领域常规的取值范围及其确定方法，实验数据不得编造，需要发明人提供的列入结尾 json 的 pending，正文不写任何【待……】占位（【全自动模式】下改为合理模拟值，逐个标注“（模拟值，待实验验证）”）；",
      "- 权利要求 10–18 条，独立权利要求覆盖发明的实际客体，从属权利要求逐层细化关键参数和可选实施方式；背景技术不少于 1200 字；发明内容包含“### 创新点分析”；具体实施方式不少于 6000 字，实施例1按步骤或部件完整展开（每步写清输入、处理、输出、参数和原理），另有替代实施例、技术效果分析和附图标记；",
      "- 说明书按【说明书行文规范】递进展开：技术问题、技术方案和具体实施方式逐项对应，每个技术特征写明技术依据和作用，多个实施例之间写清参数范围、步骤逻辑、部件连接和数据流或控制流的差异；全文不得出现任何内部提示或占位标记；",
      "- 有公式或参数计算时，按系统要求的【公式与符号规范】用 LaTeX 书写并编号，逐个说明符号和单位，同一公式在权利要求书与说明书中逐字一致；",
      "- 需要画图的地方，在附图说明中逐幅写明“图N为……的结构示意图/流程图/原理框图”，正文用“如图N所示”引用，并在摘要末尾单独一行写“摘要附图：图N”；",
      "- 每幅附图在附图说明之后给出一个 ```附图 代码块（JSON），按【附图数据规范】写明类型、方框/步骤/分层/图元和附图标记，导出 Word 时据此自动绘制黑白线条图，不要只写文字说明；",
      "- 附图不少于 7 幅且类型多样，不得全部是同一种图：方法类一般包括方法总流程图、2 幅关键步骤的细化流程图、系统框图、系统分层架构图、模块交互时序图、参数或效果曲线图和电子设备结构框图；装置/结构类一般包括整体结构示意图、剖视图、局部放大图、控制系统框图和工作流程图；每幅图的附图代码块保持紧凑；",
      "- 材料中有《查新对比报告》时：背景技术逐篇评述报告中的对比文件，权利要求1必须包含报告列出的全部区别技术特征，“创新点分析”和“有益效果”与区别特征一一对应；",
    ].join("\n"),
    "请按系统要求输出完整发明专利申请文件草稿。",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// CN publication numbers

const CN_PN = /\bCN\s?(\d{7,10})(?:\.\d)?\s?([ABCUSY]\d?)?(?![\dA-Za-z])/gi;

/** Normalise and dedupe Chinese publication / grant numbers found in free text. */
export function extractCnNumbers(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(CN_PN)) {
    const kind = (match[2] || "").toUpperCase();
    found.add(`CN${match[1]}${kind}`);
  }
  return [...found];
}

/** Public page for a CN number. Google Patents needs the kind code; without it fall back to its search. */
export function patentUrl(pn: string): string {
  const clean = pn.replace(/\s+/g, "").toUpperCase();
  if (/^CN\d{7,10}[ABCUSY]\d?$/.test(clean)) return `https://patents.google.com/patent/${clean}/zh`;
  return `https://patents.google.com/?q=${encodeURIComponent(clean)}`;
}

/** Kind code meaning for Chinese documents (shown to users in the primer and in result lists). */
export function kindLabel(pn: string): string {
  const kind = /[ABCUSY]\d?$/i.exec(pn)?.[0]?.toUpperCase()[0];
  if (kind === "A") return "发明申请公开";
  if (kind === "B" || kind === "C") return "发明授权公告";
  if (kind === "U" || kind === "Y") return "实用新型";
  if (kind === "S") return "外观设计";
  return "类型未知";
}

// ---------------------------------------------------------------------------
// Audit

const pnBase = (pn: string) => pn.replace(/\s+/g, "").toUpperCase().replace(/[A-Z]\d?$/, "");

/**
 * CN numbers cited in a background section, split into those found by this run's prior-art search (valid
 * comparison documents) and those that were not (unverified: the model may have recalled or invented them).
 */
export function citedPriorArt(background: string, priorArt: string[]): { valid: string[]; unverified: string[] } {
  const known = new Set(priorArt.filter(Boolean).map(pnBase));
  const cited = extractCnNumbers(background);
  return { valid: cited.filter((pn) => known.has(pnBase(pn))), unverified: cited.filter((pn) => !known.has(pnBase(pn))) };
}

/** Detail text of the background prior-art check, shared by the audit and the review sheet. */
export function backgroundArtDetail(valid: string[], unverified: string[]): string {
  const head = valid.length ? `引用 ${valid.join("、")}` : "未引用检索结果中的公开号，需先检索";
  return unverified.length ? `${head}；${unverified.join("、")} 不在本次检索结果中，已标注待核实，不计为对比文件` : head;
}

export interface AuditCheck {
  id: string;
  label: string;
  ok: boolean;
  weight: number;
  detail: string;
}

export interface DraftAudit {
  score: number;
  checks: AuditCheck[];
  claims: ParsedClaim[];
  pendingMarks: number;
  /** 自检所用的技术领域。 */
  domainId: string;
  domainName: string;
}

export interface ParsedClaim {
  no: number;
  text: string;
  refs: number[];
  independent: boolean;
}

// ---------------------------------------------------------------------------
// Heading normalisation: models sometimes write `# 权利要求书`, `**技术领域**`, `【背景技术】` or
// `一、发明内容：` instead of the `## ` headings the audit, the panel and the DOCX export split on.

const HEADING_ALIASES = new Map<string, InventionHeading>([
  ["摘要", "说明书摘要"],
  ["权利要求", "权利要求书"],
]);
const DECORATED_HEADING = /^(?:#{1,6}\s|\*\*|__|【|\[|[一二三四五六七八九十]+\s*[、.．:：]|\d{1,2}\s*[、.．)）]|第[一二三四五六七八九十]+部分)/;

/** The statutory section a heading-like line names, or null. Only a whole line naming the section counts. */
export function legalHeading(line: string): InventionHeading | null {
  let name = line.trim();
  if (!name || name.length > 30) return null;
  const decorated = DECORATED_HEADING.test(name);
  for (let round = 0; round < 3; round += 1) {
    name = name
      .replace(/^#{1,6}\s*/, "")
      .replace(/\s*[:：]\s*$/, "")
      .replace(/^\*\*(.*)\*\*$/, "$1")
      .replace(/^__(.*)__$/, "$1")
      .replace(/^【(.*)】$/, "$1")
      .replace(/^\[(.*)\]$/, "$1")
      .replace(/^(?:第[一二三四五六七八九十]+部分|[一二三四五六七八九十]+|\d{1,2})(?:\s*[、.．:：)）]\s*|\s+)/, "")
      .trim();
  }
  if ((INVENTION_HEADINGS as readonly string[]).includes(name)) return name as InventionHeading;
  return decorated ? (HEADING_ALIASES.get(name) ?? null) : null;
}

/** Drop a fence that wraps the whole reply (```markdown … ```), keeping fenced blocks inside it. */
function unwrapMarkdownFence(text: string): string {
  const lines = text.split(/\r?\n/);
  const first = wholeFenceLine(lines);
  if (first === -1) return text;
  let inner = false;
  for (let index = first + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!inner && /^```\S+/.test(line)) {
      inner = true;
      continue;
    }
    if (line === "```") {
      if (inner) {
        inner = false;
        continue;
      }
      lines.splice(index, 1);
      break;
    }
  }
  // Drop the chat lead-in (if any) together with the opening fence, so the saved draft starts at its title.
  lines.splice(0, first + 1);
  return lines.join("\n");
}

const WHOLE_FENCE = /^```(?:markdown|md)?\s*$/i;
const MAX_LEAD_LINES = 3;
const MAX_LEAD_CHARS = 200;

/**
 * Index of the opening fence of a whole-document wrapper, or -1. Models sometimes write a short lead-in
 * (“完整申请文件草稿已写好……”) before ```markdown; that counts only when it is at most three short plain lines and
 * the fence is followed by a heading, so a fenced example inside ordinary prose is never mistaken for the wrapper.
 */
function wholeFenceLine(lines: string[]): number {
  let lead = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (WHOLE_FENCE.test(line)) {
      if (lead === 0) return index;
      const next = lines.slice(index + 1).find((item) => item.trim())?.trim() ?? "";
      return /^#{1,6}\s/.test(next) || legalHeading(next) ? index : -1;
    }
    if (line.startsWith("```") || /^#{1,6}\s/.test(line) || legalHeading(line)) return -1;
    lead += 1;
    if (lead > MAX_LEAD_LINES || line.length > MAX_LEAD_CHARS) return -1;
  }
  return -1;
}

/** Rewrite every recognisable statutory heading as `## 名称`; text inside fenced blocks is left alone. */
export function normalizeDraftHeadings(text: string): string {
  let fenced = false;
  return unwrapMarkdownFence(text)
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      const name = legalHeading(line);
      return name ? `## ${name}` : line;
    })
    .join("\n");
}

/** Split a markdown draft into its "## " sections. */
export function splitSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = text.split(/^##\s+/m);
  for (const part of parts.slice(1)) {
    const newline = part.indexOf("\n");
    const head = (newline === -1 ? part : part.slice(0, newline)).trim();
    const body = newline === -1 ? "" : part.slice(newline + 1).trim();
    out.set(head, body);
  }
  return out;
}

function sectionOf(sections: Map<string, string>, name: string): string {
  for (const [head, body] of sections) if (head.startsWith(name)) return body;
  return "";
}

/** “权利要求”后连写的编号：单个、列举（“1、2或3”“1和2”）和范围（“1至3”“1-3”“1～3”“1至权利要求3”）。 */
const CLAIM_REF_GROUP = /权利要求\s*(\d{1,3}(?:\s*(?:[-—–~～至到]|、|,|或者|或|以及|和|及|与)\s*(?:权利要求\s*)?\d{1,3})*)/g;

/** 一段文字中“权利要求……”引用的全部编号，列举和范围都展开，例如“权利要求1、3或5至7”得到 1、3、5、6、7。 */
export function claimRefNumbers(text: string): number[] {
  const refs = new Set<number>();
  for (const match of text.matchAll(CLAIM_REF_GROUP)) {
    for (const item of match[1].replace(/权利要求\s*/g, "").split(/\s*(?:、|,|或者|或|以及|和|及|与)\s*/)) {
      const [start, end = start] = item.split(/\s*[-—–~～至到]\s*/).map(Number);
      for (let value = start; value <= end && value - start < 50; value += 1) refs.add(value);
    }
  }
  return [...refs].sort((a, b) => a - b);
}

export function parseClaims(body: string): ParsedClaim[] {
  const claims: ParsedClaim[] = [];
  let current: ParsedClaim | null = null;
  for (const line of body.split(/\r?\n/)) {
    const hit = /^\s*(\d{1,3})\s*[.、．]\s*(.*)$/.exec(line);
    if (hit) {
      if (current) claims.push(current);
      current = { no: Number(hit[1]), text: hit[2].trim(), refs: [], independent: false };
    } else if (current && line.trim()) {
      current.text += `\n${line.trim()}`;
    }
  }
  if (current) claims.push(current);
  for (const claim of claims) {
    claim.refs = claimRefNumbers(claim.text);
    claim.independent = claim.refs.length === 0 || /^一种/.test(claim.text);
  }
  return claims;
}

const VAGUE_IN_CLAIMS = ["例如", "优选", "最好是", "尤其是", "大约", "左右", "如图", "等等"];

export interface AuditOptions {
  /** 技术领域：领域对象或领域 id；不给时从草稿文本识别。 */
  domain?: TechDomain | DomainId | string | null;
  /** 本次检索得到的对比文件公开号。给出时，背景技术只把其中的公开号算作有效引用，其余记为待核实。 */
  priorArt?: string[];
}

export function auditInvention(text: string, options: AuditOptions = {}): DraftAudit {
  const domain = resolveDomain(options.domain, text);
  const sections = splitSections(normalizeDraftHeadings(text));
  const checks: AuditCheck[] = [];
  const add = (id: string, label: string, ok: boolean, weight: number, detail: string) => checks.push({ id, label, ok, weight, detail });

  const missing = INVENTION_HEADINGS.filter((name) => !sectionOf(sections, name) && !(name === "附图说明" && figuresOptional(domain)));
  add("sections", "章节齐全", missing.length === 0, 10, missing.length ? `缺少：${missing.join("、")}` : "七个法定部分都在");

  const abstract = sectionOf(sections, "说明书摘要").replace(/^摘要附图[:：].*$/gm, "").trim();
  add("abstract", "摘要不超过300字", abstract.length > 0 && abstract.replace(/\s/g, "").length <= 300, 4, `摘要 ${abstract.replace(/\s/g, "").length} 字`);

  const claims = parseClaims(sectionOf(sections, "权利要求书"));
  const independents = claims.filter((claim) => claim.independent);
  add("claim-count", "权利要求数量充足", claims.length >= 8, 10, `共 ${claims.length} 条（建议 8–15 条）`);

  const sequential = claims.every((claim, index) => claim.no === index + 1);
  add("claim-numbering", "权利要求连续编号", claims.length > 0 && sequential, 4, sequential ? "编号连续" : "编号不连续或重复");

  const badRefs = claims.filter((claim) => !claim.independent && claim.refs.some((ref) => ref >= claim.no));
  add("claim-refs", "从属权利要求只引用在前权利要求", claims.length > 0 && badRefs.length === 0, 8, badRefs.length ? `问题条：${badRefs.map((c) => c.no).join("、")}` : "引用关系正确");

  const noCharacterizing = independents.filter((claim) => !claim.text.includes("其特征在于"));
  add("claim-two-part", "独立权利要求含“其特征在于”", independents.length > 0 && noCharacterizing.length === 0, 6, noCharacterizing.length ? `缺少：第 ${noCharacterizing.map((c) => c.no).join("、")} 条` : "格式规范");


  const vague = claims.filter((claim) => VAGUE_IN_CLAIMS.some((word) => claim.text.includes(word)));
  add("claim-clarity", "权利要求无模糊用语", claims.length > 0 && vague.length === 0, 6, vague.length ? `含“例如/优选/如图”等：第 ${vague.map((c) => c.no).join("、")} 条` : "未发现模糊用语");

  const summary = sectionOf(sections, "发明内容");
  const parts = ["要解决的技术问题", "技术方案", "有益效果"].filter((name) => !summary.includes(name));
  add("summary-parts", "发明内容三段式", summary.length > 0 && parts.length === 0, 8, parts.length ? `缺少：${parts.join("、")}` : "问题-方案-效果齐全");

  const background = sectionOf(sections, "背景技术");
  const citation = options.priorArt ? citedPriorArt(background, options.priorArt) : { valid: extractCnNumbers(background), unverified: [] as string[] };
  add("background-art", "背景技术引用对比文件", citation.valid.length > 0, 6, backgroundArtDetail(citation.valid, citation.unverified));

  const figures = sectionOf(sections, "附图说明");
  const hasFigure1 = /图\s*1/.test(figures);
  const noFigures = !hasFigure1 && figuresOptional(domain) && !figures.trim();
  add("figures", "附图说明", hasFigure1 || noFigures, 4, hasFigure1 ? "已列附图" : noFigures ? `${domain.name}申请可以没有附图` : "没有图1说明");

  const embodiment = sectionOf(sections, "具体实施方式");
  const embodimentLen = embodiment.replace(/\s/g, "").length;
  add("embodiment-depth", "具体实施方式充分（≥1500字）", embodimentLen >= 1500, 12, `${embodimentLen} 字`);
  add("embodiment-example", "至少一个完整实施例", /实施例\s*[1一]/.test(embodiment), 6, /实施例\s*[1一]/.test(embodiment) ? "有实施例" : "没有标明实施例");

  const claimTerms = new Set<string>();
  for (const claim of claims) {
    const plain = claim.text.replace(/包括|通过|用于|所述|根据|利用|采用|基于|以及|设置|和|与|及|的|将|对|由/g, " ");
    for (const match of plain.matchAll(/[\u4e00-\u9fa5]{2,10}(?:模块|单元)/g)) claimTerms.add(match[0]);
  }
  const unsupported = [...claimTerms].filter((term) => !embodiment.includes(term) && !summary.includes(term));
  add("support", "权利要求术语在说明书有支持", claims.length > 0 && unsupported.length === 0, 8, unsupported.length ? `说明书未出现：${unsupported.slice(0, 6).join("、")}` : "术语均有支持");

  // 公式与参数：只在草稿用到公式时计分
  const formulas = auditFormulas(draftFormulaSources(normalizeDraftHeadings(text)));
  if (formulas.applicable) {
    const hard = formulas.issues.filter((item) => item.level === "error");
    const soft = formulas.issues.filter((item) => item.level === "warn");
    add("formula-consistency", "公式与参数前后一致", hard.length === 0, 8, hard.length ? hard.slice(0, 3).map((item) => item.detail).join("；") : "公式、符号与数值范围在全文一致");
    add("formula-style", "公式书写规范", soft.length === 0, 4, soft.length ? soft.slice(0, 3).map((item) => item.detail).join("；") : "公式均用 LaTeX 书写并编号，符号均有定义");
  }

  for (const item of domainAuditChecks({ domain, claimsText: sectionOf(sections, "权利要求书"), independentTexts: independents.map((claim) => claim.text), embodiment })) {
    checks.push(item);
  }

  const pendingMarks = (text.match(/【待[^】]*】/g) || []).length;
  const total = checks.reduce((sum, item) => sum + item.weight, 0);
  const got = checks.reduce((sum, item) => sum + (item.ok ? item.weight : 0), 0);
  return { score: Math.round((got / total) * 100), checks, claims, pendingMarks, domainId: domain.id, domainName: domain.name };
}

/** Short Chinese summary of an audit for a chat note. */
export function auditNote(audit: DraftAudit): string {
  const failed = audit.checks.filter((item) => !item.ok);
  const head = `成稿自检 ${audit.score} 分，${audit.claims.length} 条权利要求，待补充事实 ${audit.pendingMarks} 处（正式文件中已改写为正式表述，清单见内部审核单）。`;
  if (!failed.length) return `${head} 结构检查全部通过，仍需代理人审核实质内容。`;
  return `${head}\n${failed.map((item) => `· ${item.label}：${item.detail}`).join("\n")}`;
}

// ---------------------------------------------------------------------------
// Draft completeness: guards the pipeline against short or malformed model replies

/** Fewer non-whitespace characters than this is never a full application, whatever its headings. */
export const MIN_DRAFT_CHARS = 1500;
/** At least this many statutory sections must carry text. */
export const MIN_DRAFT_SECTIONS = 4;

export interface DraftShape {
  chars: number;
  found: InventionHeading[];
  missing: InventionHeading[];
  claims: number;
  complete: boolean;
  reason: string;
}

/** Is this a full application at all (before judging its quality with auditInvention)? */
export function draftShape(text: string): DraftShape {
  const normalized = normalizeDraftHeadings(text);
  const sections = splitSections(normalized);
  const found = INVENTION_HEADINGS.filter((name) => sectionOf(sections, name).trim().length > 0);
  const missing = INVENTION_HEADINGS.filter((name) => !found.includes(name));
  const chars = normalized.replace(/\s/g, "").length;
  const claims = parseClaims(sectionOf(sections, "权利要求书")).length;
  const reasons: string[] = [];
  if (chars < MIN_DRAFT_CHARS) reasons.push(`正文只有 ${chars} 字`);
  if (found.length < MIN_DRAFT_SECTIONS) reasons.push(`只识别到 ${found.length}/${INVENTION_HEADINGS.length} 个法定章节`);
  if (!claims) reasons.push("没有可识别的编号权利要求");
  return { chars, found, missing, claims, complete: reasons.length === 0, reason: reasons.join("，") };
}

/** One trace line describing a draft's shape. */
export function shapeNote(label: string, shape: DraftShape): string {
  const list = shape.found.length ? `（${shape.found.join("、")}）` : "";
  return `${label} ${shape.chars} 字，识别到 ${shape.found.length}/${INVENTION_HEADINGS.length} 个法定章节${list}，编号权利要求 ${shape.claims} 条。`;
}

/** A short single-line preview for traces, with key-like strings masked. */
export function safePreview(text: string, cap = 80): string {
  const line = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  const masked = line
    .replace(/\b(?:sk|pk|ak|rk|key|token|secret)[-_][A-Za-z0-9_-]{6,}/gi, "［已隐藏］")
    .replace(/[A-Za-z0-9+/=_-]{24,}/g, "［已隐藏］");
  if (!masked) return "（空）";
  return masked.length > cap ? `${masked.slice(0, cap)}…` : masked;
}
