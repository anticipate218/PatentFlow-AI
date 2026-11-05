import { libraryDoc } from "./patent-library.ts";
export const SCHEMA = 1;

export type View =
  | "workbench"
  | "cases"
  | "case"
  | "knowledge"
  | "radar"
  | "search"
  | "analysis"
  | "skills"
  | "models"
  | "tasks"
  | "settings"
  | "primer";

export type Stage =
  | "INTAKE"
  | "FACTS_PENDING"
  | "DISCLOSURE_DRAFTED"
  | "IN_REVIEW"
  | "READY_EXPORT";

export type FactKind = "problem" | "input" | "process" | "parameter" | "output" | "effect";
export type FactOrigin = "source" | "inference" | "inventor";
export type FactStatus = "pending" | "confirmed" | "rejected";
export type IssueLevel = "severe" | "confirm" | "improve";
export type Judgement = "明确包含" | "部分对应" | "未找到" | "待确认";
export type DockTab = "material" | "draft" | "claims" | "chart" | "figures" | "diff" | "review";
export type SearchScope = "all" | "demo" | "private";

export interface Fact {
  id: string;
  statement: string;
  kind: FactKind;
  origin: FactOrigin;
  sourceLabel: string;
  anchor: string;
  status: FactStatus;
}

export interface Claim {
  id: string;
  no: number;
  parentNo: number | null;
  text: string;
  factIds: string[];
}

export interface Issue {
  id: string;
  level: IssueLevel;
  title: string;
  detail: string;
  factId?: string;
}

export interface Proposal {
  id: string;
  title: string;
  detail: string;
  status: "open" | "accepted" | "rejected";
  claims: Claim[];
}

export interface VersionSnap {
  id: string;
  label: string;
  at: string;
  actor: string;
  disclosure: string;
  claimsText: string;
  reason: string;
}

export interface FigureNode {
  id: string;
  no: number;
  label: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  action: string;
  detail: string;
}

export interface MessageAttachment {
  name: string;
  kind: "pdf" | "text";
  chars: number;
  /** PDF page count read from the 【第 N 页】 markers when the file was attached; absent for unpaged material. */
  pages?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "trace";
  text: string;
  at: string;
  attachments?: MessageAttachment[];
}

export interface CaseMaterial {
  id: string;
  /** Set only for pipeline artifacts; uploaded files must not be replaced by name. */
  generated?: boolean;
  name: string;
  kind: "pdf" | "text";
  text: string;
  chars: number;
  at: string;
}

export interface PatentIdea {
  id: string;
  title: string;
  problem: string;
  feature: string;
  effect: string;
  pending: string;
  status: "open" | "pursued" | "dismissed";
}

export interface MemoryNote {
  id: string;
  text: string;
  source: "user" | "model";
  at: string;
}

export interface PatentCase {
  inventionDraft?: InventionDraftState;
  /** 置顶的会话排在侧边栏最前。 */
  pinned?: boolean;
  /** 案件记忆：发明人确认过的要点，每轮注入模型上下文。 */
  memory?: MemoryNote[];
  id: string;
  title: string;
  patentType: "发明";
  stage: Stage;
  demo: boolean;
  materialName: string;
  materialText: string;
  materials: CaseMaterial[];
  ideas: PatentIdea[];
  createdAt: string;
  facts: Fact[];
  claims: Claim[];
  disclosure: string;
  draftedFrom: string;
  claimMode: "broad" | "narrow";
  issues: Issue[];
  proposals: Proposal[];
  versions: VersionSnap[];
  figures: FigureNode[];
  priorArt: { d1: string | null; d2: string | null };
  messages: ChatMessage[];
  audit: AuditEvent[];
}

export interface Publication {
  id: string;
  number: string;
  title: string;
  publicationDate: string;
  assignee: string;
  ipcNote: string;
  status: "FULLTEXT_VERIFIED";
  text: string;
  claimsText: string;
  fictional: true;
}

export interface LegalNote {
  id: string;
  citation: string;
  title: string;
  point: string;
  sourceUrl: string;
  effective: string;
}

export interface InventionDraftState {
  /** 撰写时识别的技术领域 id（旧数据没有）。 */
  domain?: string;
  /** 技术领域中文名（旧数据没有）。 */
  domainName?: string;
  text: string;
  score: number;
  at: string;
  model: string;
  revised: boolean;
  pendingMarks: number;
  claimCount: number;
  priorArt: Array<{ pn: string; title: string; url: string; note?: string }>;
  checks: Array<{ label: string; ok: boolean; detail: string }>;
  distinguishing: Array<{ feature: string; problem: string; effect: string }>;
  pending: string[];
  /** 公式与参数专项审阅的记录：采用的定点修改、未能定位的建议和需要发明人确认的问题（旧数据没有）。 */
  mathReview?: {
    accepted: boolean;
    applied: Array<{ find: string; replace: string; reason: string }>;
    skipped: Array<{ find: string; reason: string; why: string }>;
    notes: string[];
  };
  /** 成稿后按发明人要求所做的修改记录（最多保留 20 条；旧数据没有）。 */
  revisions?: DraftRevisionRecord[];
  /** 修改前的版本，最近的在最后（最多保留 5 个），用于撤销上次修改（旧数据没有）。 */
  undo?: InventionDraftSnapshot[];
}

/** 一次成稿后修改：发明人的要求、套用的定点修改和修改前后的自检分数。 */
export interface DraftRevisionRecord {
  at: string;
  instruction: string;
  summary: string;
  applied: Array<{ find: string; replace: string; reason: string }>;
  skipped: Array<{ find: string; reason: string; why: string }>;
  notes: string[];
  scoreBefore: number;
  scoreAfter: number;
  model: string;
}

/** 撤销栈中的一个版本：不含它自己的撤销栈，避免层层嵌套。 */
export type InventionDraftSnapshot = Omit<InventionDraftState, "undo">;

export interface RadarHitView {
  pn: string;
  kind: string;
  title: string;
  url: string;
  sourceUrl: string;
  snippet: string;
  query: string;
  foundAt: string;
}

export interface Subscription {
  id: string;
  name: string;
  keywords: string[];
  schedule: "daily" | "weekly" | "manual";
  enabled: boolean;
  createdAt: string;
  ipc?: string;
  lastRunAt?: string;
  lastStatus?: "ok" | "error";
  lastDetail?: string;
  /** Publication numbers without kind code that this topic already reported. */
  seen?: string[];
  hits?: RadarHitView[];
}

export interface Job {
  id: string;
  title: string;
  status: "succeeded" | "blocked";
  at: string;
  detail: string;
  durationMs: number;
}

export interface SkillToggle {
  id: string;
  name: string;
  summary: string;
  enabled: boolean;
  lockedReason?: string;
}

export interface ModelConfig {
  baseUrl: string;
  modelId: string;
  keyHint: string;
  secret: string;
}

export interface KnowledgeDoc {
  id: string;
  name: string;
  kind: "pdf" | "text";
  text: string;
  chars: number;
  at: string;
}

export interface Persisted {
  schema: number;
  cases: PatentCase[];
  activeCaseId: string | null;
  subscriptions: Subscription[];
  jobs: Job[];
  skills: SkillToggle[];
  model: ModelConfig;
  knowledge: KnowledgeDoc[];
  knowledgeQueue: Array<{ name: string; kind: "pdf" | "text"; text: string }>;
  dockTab: DockTab;
  searchQuery: string;
  searchScope: SearchScope;
  selectedPubId: string | null;
}

export type Action =
  | { type: "navigate"; view?: View }
  | { type: "open-case"; id: string }
  | { type: "focus-case"; id: string }
  | { type: "create-case"; title: string; text: string; fileName: string; skill?: boolean; id?: string; materials?: Array<{ name: string; kind: "pdf" | "text"; text: string }> }
  | { type: "attach-materials"; caseId: string; materials: Array<{ name: string; kind: "pdf" | "text"; text: string }>; replaceNamed?: boolean }
  | { type: "merge-ideas"; caseId: string; ideas: Array<{ title: string; problem: string; feature: string; effect: string; pending: string }> }
  | { type: "pursue-idea"; caseId: string; title: string }
  | { type: "idea-status"; caseId: string; ideaId: string; status: PatentIdea["status"] }
  | { type: "delete-case"; id: string }
  | { type: "restore-demo" }
  | { type: "fact-status"; caseId: string; factId: string; status: FactStatus }
  | { type: "confirm-source"; caseId: string }
  | { type: "add-fact"; caseId: string; kind: FactKind; statement: string }
  | { type: "generate"; caseId: string }
  | { type: "resolve-proposal"; caseId: string; proposalId: string; decision: "accepted" | "rejected" }
  | { type: "figure-label"; caseId: string; figureId: string; label: string }
  | { type: "pin-art"; caseId: string; pubId: string; slot: "d1" | "d2" }
  | { type: "chat-note"; caseId: string; role: "user" | "assistant" | "trace"; text: string; attachments?: MessageAttachment[] }
  | { type: "merge-facts"; caseId: string; sourceLabel: string; facts: Array<{ statement: string; kind: FactKind; origin: "source" | "inference" }> }
  | { type: "rename-case"; caseId: string; title: string }
  | { type: "set-dock"; tab: DockTab }
  | { type: "set-dock-width"; width: number }
  | { type: "select-pub"; id: string | null }
  | { type: "search"; query: string; scope: SearchScope }
  | { type: "add-sub"; name: string; keywords: string; schedule: Subscription["schedule"]; ipc?: string }
  | { type: "radar-result"; id: string; ranAt: string; ok: boolean; detail: string; hits: RadarHitView[] }
  | { type: "set-invention-draft"; caseId: string; draft: InventionDraftState }
  | { type: "revise-invention-draft"; caseId: string; draft: InventionDraftState }
  | { type: "undo-invention-draft"; caseId: string }
  | { type: "toggle-sub"; id: string }
  | { type: "remove-sub"; id: string }
  | { type: "toggle-skill"; id: string }
  | { type: "save-model"; baseUrl: string; modelId: string; key: string; rememberKey: boolean }
  | { type: "forget-key" }
  | { type: "export-done"; caseId: string }
  | { type: "add-knowledge"; name: string; kind: "pdf" | "text"; text: string }
  | { type: "remove-knowledge"; id: string }
  | { type: "queue-knowledge"; ids: string[] }
  | { type: "clear-knowledge-queue" }
  | { type: "pin-case"; caseId: string; pinned: boolean }
  | { type: "restore-case"; patentCase: PatentCase; index?: number; activate?: boolean }
  | { type: "clear-cases" }
  | { type: "clear-chat"; caseId: string }
  | { type: "add-memory"; caseId: string; text: string; source?: "user" | "model" }
  | { type: "update-memory"; caseId: string; id: string; text: string }
  | { type: "remove-memory"; caseId: string; id: string }
  | { type: "wipe" };

export const DOCK_WIDTH_KEY = "patentflow.dockWidth";

export const STAGE_LABEL: Record<Stage, string> = {
  INTAKE: "收件",
  FACTS_PENDING: "待确认事实",
  DISCLOSURE_DRAFTED: "交底草稿",
  IN_REVIEW: "质量审核",
  READY_EXPORT: "可导出草稿",
};

export const KIND_LABEL: Record<FactKind, string> = {
  problem: "技术问题",
  input: "输入",
  process: "处理过程",
  parameter: "参数",
  output: "输出",
  effect: "技术效果",
};

export const LEVEL_LABEL: Record<IssueLevel, string> = {
  severe: "严重问题",
  confirm: "需人工确认",
  improve: "建议优化",
};

export const DEMO_MATERIAL = `本发明涉及高分辨率遥感影像处理。
现有建筑物提取方法在阴影、树木遮挡和密集屋顶边缘处容易粘连，边界误差较大。
本发明的输入为高分辨率遥感影像。
处理过程包括使用编码器提取多尺度特征。
在解码阶段引入边界细化模块，利用边界损失约束分割轮廓。
可选地，边界损失的权重取 0.3。
输出为建筑物二值掩膜。
在内部示例图上，边界细化后的轮廓更贴合人工标绘结果。
该效果尚未形成可复现的实验记录。`;

export const PUBLICATIONS: Publication[] = [
  {
    id: "pub-demo-1",
    number: "DEMO-RS-0001",
    title: "一种高分辨率遥感影像语义分割方法",
    publicationDate: "2024-06-18",
    assignee: "虚构权利人（示范）",
    ipcNote: "未标注。示范数据不猜测分类号。",
    status: "FULLTEXT_VERIFIED",
    fictional: true,
    text: "本发明公开一种高分辨率遥感影像语义分割方法。该方法使用编码器提取特征，并使用解码器得到类别掩膜。全文讨论的是地类分类，没有单独处理房屋轮廓。",
    claimsText: "1. 一种高分辨率遥感影像语义分割方法，其特征在于，使用编码器和解码器得到类别掩膜。",
  },
  {
    id: "pub-demo-2",
    number: "DEMO-CV-0002",
    title: "一种通用图像分割网络",
    publicationDate: "2023-11-02",
    assignee: "虚构权利人（示范）",
    ipcNote: "未标注。示范数据不猜测分类号。",
    status: "FULLTEXT_VERIFIED",
    fictional: true,
    text: "本方法面向普通可见光照片，使用卷积网络完成前景与背景划分。它不处理航拍地物，也不讨论房屋轮廓。",
    claimsText: "1. 一种图像划分网络，用于区分前景和背景。",
  },
];

export const LEGAL_NOTES: LegalNote[] = [
  {
    id: "law-cn-33",
    citation: "专利法第三十三条（2020年修正）",
    title: "申请文件的修改范围",
    point: "对发明和实用新型申请文件的修改，不得超出原说明书和权利要求书记载的范围。本工作台把“已确认事实”当作目前可以写入草稿的范围；材料里没有的实验、参数和效果保持为待补充。正式提交之后，还必须对照冻结的原始文本，不能靠对话记录覆盖申请文件。",
    sourceUrl: "https://www.cnipa.gov.cn/art/2020/11/23/art_97_155167.html",
    effective: "现行文本以国家知识产权局公布的 2020 年修正版本为准",
  },
];

export function builtInKnowledge(id: string): KnowledgeDoc | null {
  const publication = PUBLICATIONS.find((item) => item.id === id);
  if (publication) {
    const text = `${publication.title}\n\n${publication.text}\n\n${publication.claimsText}`;
    return { id: publication.id, name: `${publication.number}.md`, kind: "text", text, chars: text.length, at: `${publication.publicationDate}T00:00:00.000Z` };
  }
  const note = LEGAL_NOTES.find((item) => item.id === id);
  if (note) {
    const text = `${note.citation}\n${note.title}\n${note.point}`;
    return { id: note.id, name: `${note.citation}.md`, kind: "text", text, chars: text.length, at: SEED_AT };
  }
  // 专利分类与样例知识库（领域指引、虚构示范样例、真实参考资料）
  return libraryDoc(id);
}

const DEMO_CASE_ID = "case-demo-rs";
const SEED_AT = "2026-10-20T08:30:00.000Z";

export function confirmedKey(facts: Fact[]): string {
  return facts
    .filter((fact) => fact.status === "confirmed" && fact.origin !== "inference")
    .map((fact) => fact.id)
    .join("|");
}

export function extractFacts(text: string, sourceLabel: string): Fact[] {
  const parts = text
    .split(/[\n。；;]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8);
  const facts: Fact[] = parts.map((statement, index) => ({
    id: `f${index + 1}`,
    statement,
    kind: classify(statement),
    origin: "source" as const,
    sourceLabel,
    anchor: `第 ${index + 1} 句`,
    status: "pending" as const,
  }));
  const hasEffect = facts.some((fact) => fact.kind === "effect");
  const hasGap = facts.some((fact) => /尚未|未形成|不可复现|没有实验/.test(fact.statement));
  if (!hasEffect) {
    facts.push({
      id: "f-infer-effect",
      statement: "材料没有写明可验证的技术效果。不能自动补充实验、数据或对比结果。",
      kind: "effect",
      origin: "inference",
      sourceLabel: "本地规则",
      anchor: "推断",
      status: "pending",
    });
  } else if (hasGap) {
    facts.push({
      id: "f-infer-gap",
      statement: "材料同时写了效果描述，又写明该效果还不能复现。确认实验记录之前，这条效果不能写入正文。",
      kind: "effect",
      origin: "inference",
      sourceLabel: "本地规则",
      anchor: "推断",
      status: "pending",
    });
  }
  return facts;
}

function classify(statement: string): FactKind {
  if (/尚未|未形成|不可复现|没有实验/.test(statement)) return "problem";
  if (/权重|参数|阈值|学习率|λ|0\.\d/.test(statement)) return "parameter";
  if (/效果|提高|降低|精度|贴合|改善/.test(statement)) return "effect";
  if (/输出为|掩膜|掩模/.test(statement)) return "output";
  if (/输入为|遥感影像|图像|数据/.test(statement)) return "input";
  if (/问题|不足|误差|容易|难以|粘连/.test(statement)) return "problem";
  return "process";
}

export function judge(feature: string, corpus: string): Judgement {
  const normalized = corpus.replace(/\s+/g, "");
  if (!normalized.trim()) return "待确认";
  const coreText = feature
    .replace(/本发明|涉及|的输入为|处理过程包括|可选地|输出为|在于|一种|该方法/g, "")
    .replace(/[^\u4e00-\u9fffA-Za-z0-9.]/g, "");
  if (coreText.length >= 6 && coreText.length <= 24 && normalized.includes(coreText)) return "明确包含";
  const grams = charGrams(feature);
  const strongHits = grams.filter((gram) => normalized.includes(gram));
  if (strongHits.length > 0) return "部分对应";
  return "未找到";
}

function writableFacts(facts: Fact[]): Fact[] {
  return facts.filter((fact) => fact.status === "confirmed" && fact.origin !== "inference");
}

function charGrams(input: string): string[] {
  const compact = input.replace(/[^\u4e00-\u9fffA-Za-z0-9.]/g, "");
  const grams = new Set<string>();
  for (let index = 0; index <= compact.length - 4; index += 1) grams.add(compact.slice(index, index + 4));
  return [...grams];
}

export function evidenceSnippet(feature: string, corpus: string): string {
  const normalized = corpus.replace(/\s+/g, "");
  const gram = charGrams(feature).find((item) => normalized.includes(item));
  if (!gram) return "示范全文中没有可定位的对应表述。";
  const index = normalized.indexOf(gram);
  const start = Math.max(0, index - 16);
  const end = Math.min(normalized.length, index + gram.length + 16);
  return `…${normalized.slice(start, end)}…`;
}

export function buildClaims(facts: Fact[], mode: "broad" | "narrow"): Claim[] {
  const confirmed = writableFacts(facts);
  const steps = confirmed.filter((fact) => fact.kind === "process" || fact.kind === "output");
  const inputCandidates = confirmed.filter((fact) => fact.kind === "input");
  const preferredInput = inputCandidates.find((fact) => fact.statement.includes("输入为")) ?? inputCandidates[0];
  const inputs = preferredInput ? [preferredInput] : [];
  const params = confirmed.filter((fact) => fact.kind === "parameter");
  const effects = confirmed.filter((fact) => fact.kind === "effect");
  if (steps.length === 0) return [];
  const independentFacts = mode === "broad" ? [...inputs, ...steps, ...params] : [...inputs, ...steps];
  const subject = confirmed.some((fact) => fact.statement.includes("遥感")) ? "遥感影像处理方法" : "技术处理方法";
  const claims: Claim[] = [
    {
      id: "c1",
      no: 1,
      parentNo: null,
      factIds: independentFacts.map((fact) => fact.id),
      text: `一种${subject}，其特征在于，包括：${independentFacts
        .map((fact, index) => `（${index + 1}）${stripPeriod(fact.statement)}`)
        .join("；")}。`,
    },
  ];
  const dependents = mode === "broad" ? effects : [...params, ...effects];
  dependents.forEach((fact, index) => {
    claims.push({
      id: `c${index + 2}`,
      no: index + 2,
      parentNo: 1,
      factIds: [fact.id],
      text: `根据权利要求1所述的方法，其特征在于，${stripPeriod(fact.statement)}。`,
    });
  });
  return claims;
}

function shortLabel(statement: string): string {
  const cleaned = statement
    .replace(/本发明|涉及|的输入为|处理过程包括|输出为|可选地[，,]?/g, "")
    .replace(/[。；]/g, "")
    .trim();
  const firstClause = cleaned.split(/[，、]/)[0]?.trim() || cleaned;
  return firstClause.slice(0, 14);
}

function stripPeriod(text: string): string {
  return text.replace(/[。；;]+$/g, "");
}

export function defaultFigures(facts: Fact[]): FigureNode[] {
  const confirmed = writableFacts(facts);
  const picked = [
    confirmed.find((fact) => fact.kind === "input"),
    ...confirmed.filter((fact) => fact.kind === "process").slice(0, 2),
    confirmed.find((fact) => fact.kind === "output"),
  ].filter((fact): fact is Fact => Boolean(fact));
  if (picked.length < 2) {
    return [
      { id: "fig-1", no: 1, label: "输入" },
      { id: "fig-2", no: 2, label: "处理" },
      { id: "fig-3", no: 3, label: "输出" },
    ];
  }
  return picked.map((fact, index) => ({
    id: `fig-${fact.id}`,
    no: index + 1,
    label: shortLabel(fact.statement),
  }));
}

export function renderDisclosure(patentCase: PatentCase): string {
  const confirmed = writableFacts(patentCase.facts);
  const section = (title: string, items: Fact[], empty: string) => {
    const body = items.length
      ? items.map((fact) => `${fact.statement}（依据：${fact.sourceLabel}，${fact.anchor}）`).join("\n\n")
      : `【待补充】${empty}`;
    return `## ${title}\n\n${body}`;
  };
  const figureText = patentCase.figures.length
    ? patentCase.figures.map((figure) => `图${figure.no}是${figure.label}。`).join("\n")
    : "【待补充】确认处理步骤后生成附图说明。";
  return [
    `# ${patentCase.title}`,
    "",
    "专利类型：发明",
    "文件性质：交底草稿。须由发明人和代理人审定，不构成法律意见，也不能代替正式申请文件。",
    "",
    section("技术领域", confirmed.filter((fact) => fact.kind === "input").slice(0, 2), "待补充该方法实际应用的技术场景。"),
    "",
    section("背景技术", confirmed.filter((fact) => fact.kind === "problem"), "待补充现有技术的具体问题。"),
    "",
    section("发明内容", confirmed.filter((fact) => fact.kind === "process" || fact.kind === "output"), "待补充已经确认的处理步骤和输出。"),
    "",
    section("可选技术特征", confirmed.filter((fact) => fact.kind === "parameter"), "没有已确认的可选参数。"),
    "",
    section("技术效果", confirmed.filter((fact) => fact.kind === "effect"), "待发明人补充可验证的技术效果。系统不会编写实验数据。"),
    "",
    `## 附图说明\n\n${figureText}`,
    "",
    "## 具体实施方式",
    "",
    confirmed.length
      ? confirmed.map((fact) => `- ${fact.statement}（${fact.anchor}）`).join("\n")
      : "【待补充】确认技术事实后再生成实施方式。",
  ].join("\n");
}

export function buildIssues(patentCase: PatentCase, publications: Publication[]): Issue[] {
  const issues: Issue[] = [];
  const confirmed = writableFacts(patentCase.facts);
  if (patentCase.disclosure && !confirmed.some((fact) => fact.kind === "process")) {
    issues.push({
      id: "issue-process",
      level: "severe",
      title: "缺少已确认的处理步骤",
      detail: "没有处理步骤时，不形成方法权利要求，也不能把草稿当作可导出的技术文本。",
    });
  }
  if (!confirmed.some((fact) => fact.kind === "effect")) {
    issues.push({
      id: "issue-effect",
      level: "confirm",
      title: "技术效果尚未确认",
      detail: "算法相关主题需要说明可验证的技术效果。请由发明人补充实验条件、数据或明确保留为待确认。",
    });
  }
  patentCase.facts
    .filter((fact) => fact.status === "pending" && fact.origin === "source")
    .forEach((fact) => {
      issues.push({
        id: `issue-${fact.id}`,
        level: "confirm",
        title: "仍有来源事实待确认",
        detail: fact.statement,
        factId: fact.id,
      });
    });
  patentCase.facts
    .filter((fact) => fact.status === "pending" && fact.origin === "inference")
    .forEach((fact) => {
      issues.push({
        id: `issue-${fact.id}`,
        level: "confirm",
        title: "有一条推断还没有确认",
        detail: `${fact.statement} 未确认的推断不会写入正文。`,
        factId: fact.id,
      });
    });
  if (patentCase.disclosure.includes("【待补充】")) {
    issues.push({
      id: "issue-gap",
      level: "improve",
      title: "交底书还有待补充章节",
      detail: "导出的文件会保留这些标记。可以补事实后更新草稿，也可以明确把缺口留给发明人。",
    });
  }
  const pinned = [patentCase.priorArt.d1, patentCase.priorArt.d2]
    .map((id) => publications.find((item) => item.id === id))
    .filter((item): item is Publication => Boolean(item));
  pinned.forEach((publication) => {
    const overlapped = confirmed.filter((fact) => fact.kind === "process" && judge(fact.statement, `${publication.text}\n${publication.claimsText}`) !== "未找到");
    if (overlapped.length) {
      issues.push({
        id: `issue-art-${publication.id}`,
        level: "confirm",
        title: `${publication.number} 与部分处理特征有字面重叠`,
        detail: "这只说明示范文本里出现了相近表述，不是新颖性或创造性结论。",
      });
    }
  });
  return issues;
}

export function claimsToText(claims: Claim[]): string {
  return claims.map((claim) => `${claim.no}. ${claim.text}`).join("\n\n");
}

export function lineDiff(before: string, after: string): Array<{ type: "same" | "add" | "del"; text: string }> {
  const a = before.split("\n");
  const b = after.split("\n");
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: Array<{ type: "same" | "add" | "del"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ type: "same", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", text: a[i] });
      i += 1;
    } else {
      rows.push({ type: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    rows.push({ type: "del", text: a[i] });
    i += 1;
  }
  while (j < b.length) {
    rows.push({ type: "add", text: b[j] });
    j += 1;
  }
  return rows.filter((row) => row.text.trim().length > 0 || row.type === "same");
}

export function seed(): Persisted {
  const demo = createPatentCase({
    id: DEMO_CASE_ID,
    title: "基于边界细化的遥感影像建筑物分割方法",
    text: DEMO_MATERIAL,
    fileName: "示范材料.md",
    demo: true,
    at: SEED_AT,
  });
  return {
    schema: SCHEMA,
    cases: [demo],
    activeCaseId: DEMO_CASE_ID,
    subscriptions: [],
    jobs: [
      {
        id: "job-seed",
        title: "装入示范案件",
        status: "succeeded",
        at: SEED_AT,
        detail: "只装入本地示范材料，没有访问专利数据源，也没有调用外部模型。",
        durationMs: 4,
      },
    ],
    skills: [
      { id: "disclosure", name: "交底书编写", summary: "先抽取事实，确认后再起草。按证据流程执行这一顺序。", enabled: true },
      { id: "application", name: "申请文件", summary: "权利要求和说明书草稿从已确认事实生成，缺少的部分保持待补充。", enabled: true },
      { id: "chart", name: "权利要求对照", summary: "把已确认特征与示范文献做字面定位，并标明这不是法律结论。", enabled: true },
      { id: "reader", name: "专利解读", summary: "可以阅读示范文献和你上传的资料。", enabled: true },
      { id: "search", name: "著录检索", summary: "当前检索示范库和你上传的资料。", enabled: true },
      { id: "crawl", name: "官网抓取", summary: "上游技能中的抓取脚本。", enabled: false, lockedReason: "未取得数据许可前不启用，也不能把网页访问显示成全库同步。" },
      { id: "oa", name: "审查答复", summary: "需要提交时的冻结文本和审查意见原件。当前版本不提供答复起草。", enabled: false, lockedReason: "留到有冻结快照和审查意见之后。" },
    ],
    model: {
      baseUrl: "https://apihub.agnes-ai.com/v1",
      modelId: "agnes-2.5-flash",
      keyHint: "未保存密钥",
      secret: "",
    },
    knowledge: [],
    knowledgeQueue: [],
    dockTab: "material",
    searchQuery: "",
    searchScope: "all",
    selectedPubId: "pub-demo-1",
  };
}

export function createPatentCase(input: {
  id: string;
  title: string;
  text: string;
  fileName: string;
  demo: boolean;
  at: string;
  materials?: Array<{ name: string; kind: "pdf" | "text"; text: string }>;
}): PatentCase {
  const materials = toMaterials(input);
  const materialText = materials.map((item) => item.text).filter(Boolean).join("\n\n");
  const materialName = materials[0]?.name || input.fileName;
  const facts = extractFacts(materialText, materialName);
  const pendingSource = facts.filter((fact) => fact.origin === "source").length;
  const patentCase: PatentCase = {
    id: input.id,
    title: input.title.trim() || inferTitle(materialText),
    patentType: "发明",
    stage: "FACTS_PENDING",
    demo: input.demo,
    materialName,
    materialText,
    materials,
    ideas: [],
    createdAt: input.at,
    facts,
    claims: [],
    disclosure: "",
    draftedFrom: "",
    claimMode: "broad",
    issues: [],
    proposals: [],
    versions: [],
    figures: [],
    priorArt: { d1: null, d2: null },
    messages: [
      {
        id: `${input.id}-m1`,
        role: "user",
        at: input.at,
        text: `请只根据《${materialName}》整理技术事实。我确认之前，不要把推断写进交底书。`,
      },
      {
        id: `${input.id}-m2`,
        role: "trace",
        at: input.at,
        text: "本地证据流程已完成切句和分类。外部模型没有被调用。",
      },
      {
        id: `${input.id}-m3`,
        role: "assistant",
        at: input.at,
        text: `整理出 ${pendingSource} 条来源事实。带“推断”标记的内容不会进入正文。`,
      },
    ],
    audit: [
      {
        id: `${input.id}-a1`,
        at: input.at,
        action: "建立案件",
        detail: input.demo ? "从内置示范材料建立。" : "从用户粘贴或上传的文本建立。",
      },
    ],
  };
  return { ...patentCase, issues: buildIssues(patentCase, PUBLICATIONS) };
}

function toMaterials(input: {
  id: string;
  text: string;
  fileName: string;
  at: string;
  materials?: Array<{ name: string; kind: "pdf" | "text"; text: string }>;
}): CaseMaterial[] {
  if (input.materials?.length) {
    return input.materials.map((item, index) => ({
      id: `${input.id}-mat-${index}`,
      name: item.name,
      kind: item.kind,
      text: item.text.trim(),
      chars: item.text.trim().length,
      at: input.at,
    }));
  }
  const text = input.text.trim();
  if (!text) return [];
  return [{
    id: `${input.id}-mat`,
    name: input.fileName,
    kind: /\.pdf$/i.test(input.fileName) ? "pdf" : "text",
    text,
    chars: text.length,
    at: input.at,
  }];
}

export function normalizeCase(patentCase: PatentCase): PatentCase {
  const materials = patentCase.materials?.length
    ? patentCase.materials
    : patentCase.materialText
      ? [{
          id: `${patentCase.id}-mat`,
          name: patentCase.materialName || "材料.md",
          kind: /\.pdf$/i.test(patentCase.materialName || "") ? "pdf" as const : "text" as const,
          text: patentCase.materialText,
          chars: patentCase.materialText.length,
          at: patentCase.createdAt,
        }]
      : [];
  return {
    ...patentCase,
    materials,
    ideas: patentCase.ideas ?? [],
    materialText: materials.map((item) => item.text).filter(Boolean).join("\n\n") || patentCase.materialText,
    materialName: materials[0]?.name || patentCase.materialName,
  };
}

export function normalizeWorkspace(state: Persisted): Persisted {
  return {
    ...state,
    cases: (state.cases ?? []).map(normalizeCase),
    knowledge: state.knowledge ?? [],
    knowledgeQueue: state.knowledgeQueue ?? [],
  };
}

function inferTitle(text: string): string {
  const line = text.split(/[\n。]/).map((item) => item.trim()).find((item) => item.length >= 6) ?? "未命名技术主题";
  return line.replace(/^本发明涉及/, "").slice(0, 28);
}

function withCase(state: Persisted, caseId: string, update: (patentCase: PatentCase) => PatentCase): Persisted {
  return {
    ...state,
    cases: state.cases.map((patentCase) => (patentCase.id === caseId ? update(patentCase) : patentCase)),
  };
}

function pushJob(state: Persisted, job: Job): Persisted {
  return { ...state, jobs: [job, ...state.jobs].slice(0, 40) };
}

function stamp(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function reduce(state: Persisted, action: Action): Persisted {
  switch (action.type) {
    case "navigate":
      return state;
    case "open-case":
    case "focus-case":
      return { ...state, activeCaseId: action.id, dockTab: action.type === "open-case" ? "material" : state.dockTab };
    case "create-case": {
      const fromFiles = action.materials?.length ? action.materials : undefined;
      const patentCase = createPatentCase({
        id: action.id || stamp("case"),
        title: action.title,
        text: fromFiles ? fromFiles.map((item) => item.text).join("\n\n") : action.text,
        fileName: fromFiles?.[0]?.name || action.fileName,
        materials: fromFiles,
        demo: false,
        at: new Date().toISOString(),
      });
      const opened = action.skill
        ? {
            ...patentCase,
            facts: [],
            issues: [],
            messages: [],
            stage: "INTAKE" as const,
          }
        : patentCase;
      return pushJob(
        { ...state, cases: [opened, ...state.cases], activeCaseId: opened.id, dockTab: "material" },
        {
          id: stamp("job"),
          title: "解析材料并抽取事实",
          status: "succeeded",
          at: opened.createdAt,
          detail: `《${opened.title}》已建立，等待确认来源事实。`,
          durationMs: 6,
        },
      );
    }
    case "chat-note":
      return withCase(state, action.caseId, (patentCase) => ({
        ...patentCase,
        messages: [
          ...patentCase.messages,
          {
            id: stamp("msg"),
            role: action.role,
            at: new Date().toISOString(),
            text: action.text,
            attachments: action.attachments,
          },
        ],
      }));
    case "attach-materials":
      return withCase(state, action.caseId, (patentCase) => {
        const replacedNames = new Set(action.replaceNamed ? action.materials.filter(item => item.text.trim()).map(item => item.name) : []);
        const existing = patentCase.materials.filter(item => !item.generated || !replacedNames.has(item.name));
        const incoming = action.materials
          .filter((item) => item.text.trim())
          .filter((item) => !existing.some((current) => current.name === item.name && current.text === item.text.trim()))
          .map((item) => ({
            id: stamp("mat"),
            generated: action.replaceNamed || undefined,
            name: item.name,
            kind: item.kind,
            text: item.text.trim(),
            chars: item.text.trim().length,
            at: new Date().toISOString(),
          }));
        if (incoming.length === 0) return patentCase;
        const materials = [...existing, ...incoming];
        return {
          ...patentCase,
          materials,
          materialName: materials[0]?.name || patentCase.materialName,
          materialText: materials.map((item) => item.text).filter(Boolean).join("\n\n"),
          audit: [
            ...patentCase.audit,
            {
              id: stamp("audit"),
              at: new Date().toISOString(),
              action: action.replaceNamed ? "更新生成材料" : "附加材料",
              detail: incoming.map((item) => `《${item.name}》`).join("、"),
            },
          ],
        };
      });
    case "merge-ideas":
      return withCase(state, action.caseId, (patentCase) => {
        const known = new Set(patentCase.ideas.map((idea) => idea.title));
        const ideas = [
          ...patentCase.ideas,
          ...action.ideas
            .filter((idea) => idea.title.trim() && !known.has(idea.title.trim()))
            .map((idea) => ({
              id: stamp("idea"),
              title: idea.title.trim(),
              problem: idea.problem.trim(),
              feature: idea.feature.trim(),
              effect: idea.effect.trim(),
              pending: idea.pending.trim(),
              status: "open" as const,
            })),
        ];
        return { ...patentCase, ideas };
      });
    case "pursue-idea":
      return withCase(state, action.caseId, (patentCase) => ({
        ...patentCase,
        ideas: patentCase.ideas.map((idea) => (idea.title === action.title.trim() ? { ...idea, status: "pursued" as const } : idea)),
      }));
    case "idea-status":
      return withCase(state, action.caseId, (patentCase) => ({
        ...patentCase,
        ideas: patentCase.ideas.map((idea) => (idea.id === action.ideaId ? { ...idea, status: action.status } : idea)),
      }));
    case "rename-case":
      return withCase(state, action.caseId, (patentCase) => ({ ...patentCase, title: action.title.trim() || patentCase.title }));
    case "merge-facts":
      return withCase(state, action.caseId, (patentCase) => {
        const known = new Set(patentCase.facts.map((fact) => fact.statement));
        const facts = [
          ...patentCase.facts,
          ...action.facts
            .filter((fact) => fact.statement.trim() && !known.has(fact.statement.trim()))
            .map((fact) => ({
              id: stamp("fact"),
              statement: fact.statement.trim(),
              kind: fact.kind,
              origin: fact.origin,
              sourceLabel: action.sourceLabel,
              anchor: fact.origin === "inference" ? "推断，不写入正文" : action.sourceLabel,
              status: "pending" as const,
            })),
        ];
        const next = { ...patentCase, facts, stage: patentCase.disclosure ? patentCase.stage : ("FACTS_PENDING" as const) };
        return { ...next, issues: buildIssues(next, PUBLICATIONS) };
      });
    case "delete-case": {
      const cases = state.cases.filter((patentCase) => patentCase.id !== action.id);
      return { ...state, cases, activeCaseId: state.activeCaseId === action.id ? cases[0]?.id ?? null : state.activeCaseId };
    }
    case "restore-demo":
      if (state.cases.some((patentCase) => patentCase.id === DEMO_CASE_ID)) return state;
      return { ...state, cases: [seed().cases[0], ...state.cases], activeCaseId: DEMO_CASE_ID };
    case "fact-status":
      return withCase(state, action.caseId, (patentCase) => {
        const next: PatentCase = {
          ...patentCase,
          facts: patentCase.facts.map((fact) => (fact.id === action.factId ? { ...fact, status: action.status } : fact)),
          audit: [
            {
              id: stamp("audit"),
              at: new Date().toISOString(),
              action: action.status === "confirmed" ? "确认事实" : action.status === "rejected" ? "排除事实" : "退回事实",
              detail: patentCase.facts.find((fact) => fact.id === action.factId)?.statement ?? "",
            },
            ...patentCase.audit,
          ],
        };
        return { ...next, issues: buildIssues(next, PUBLICATIONS), stage: next.disclosure ? next.stage : "FACTS_PENDING" };
      });
    case "confirm-source":
      return withCase(state, action.caseId, (patentCase) => {
        const next: PatentCase = {
          ...patentCase,
          facts: patentCase.facts.map((fact) => (fact.origin === "source" && fact.status === "pending" ? { ...fact, status: "confirmed" } : fact)),
          audit: [{ id: stamp("audit"), at: new Date().toISOString(), action: "确认全部来源事实", detail: "推断仍保持待确认。" }, ...patentCase.audit],
        };
        return { ...next, issues: buildIssues(next, PUBLICATIONS) };
      });
    case "add-fact":
      return withCase(state, action.caseId, (patentCase) => {
        const fact: Fact = {
          id: stamp("fact"),
          statement: action.statement.trim(),
          kind: action.kind,
          origin: "inventor",
          sourceLabel: "发明人补充",
          anchor: "工作台当面补充",
          status: "confirmed",
        };
        const next: PatentCase = {
          ...patentCase,
          facts: [...patentCase.facts, fact],
          audit: [{ id: stamp("audit"), at: new Date().toISOString(), action: "发明人补充事实", detail: fact.statement }, ...patentCase.audit],
          messages: [
            ...patentCase.messages,
            { id: stamp("msg"), role: "user", at: new Date().toISOString(), text: `补充一条已确认事实：${fact.statement}` },
          ],
        };
        return { ...next, issues: buildIssues(next, PUBLICATIONS) };
      });
    case "generate":
      return generateDraft(state, action.caseId);
    case "resolve-proposal":
      return resolveProposal(state, action);
    case "figure-label":
      return withCase(state, action.caseId, (patentCase) => {
        const figures = patentCase.figures.map((figure) => (figure.id === action.figureId ? { ...figure, label: action.label } : figure));
        const next = { ...patentCase, figures };
        return patentCase.disclosure ? { ...next, disclosure: renderDisclosure(next), issues: buildIssues({ ...next, disclosure: renderDisclosure(next) }, PUBLICATIONS) } : next;
      });
    case "pin-art":
      return withCase(state, action.caseId, (patentCase) => {
        const priorArt = { ...patentCase.priorArt, [action.slot]: action.pubId };
        const next = { ...patentCase, priorArt, audit: [{ id: stamp("audit"), at: new Date().toISOString(), action: `标为${action.slot.toUpperCase()}`, detail: action.pubId }, ...patentCase.audit] };
        return { ...next, issues: buildIssues(next, PUBLICATIONS) };
      });
    case "set-dock":
      return { ...state, dockTab: action.tab };
    case "set-dock-width":
      return state;
    case "select-pub":
      return { ...state, selectedPubId: action.id };
    case "search":
      return { ...state, searchQuery: action.query, searchScope: action.scope };
    case "add-sub": {
      const keywords = action.keywords.split(/[，,、\s]+/).map((item) => item.trim()).filter(Boolean);
      const subscription: Subscription = {
        id: stamp("sub"),
        name: action.name.trim(),
        keywords,
        schedule: action.schedule,
        enabled: true,
        ipc: action.ipc?.trim().toUpperCase() || undefined,
        createdAt: new Date().toISOString(),
      };
      return pushJob(
        { ...state, subscriptions: [subscription, ...state.subscriptions] },
        {
          id: stamp("job"),
          title: "保存专利雷达订阅",
          status: "succeeded",
          at: subscription.createdAt,
          detail: "订阅已保存。到点会用 AnySearch 检索公开的中国专利页面，只保留带真实公开号的结果。",
          durationMs: 1,
        },
      );
    }
    case "set-invention-draft":
      return pushJob(
        withCase(state, action.caseId, (patentCase) => ({ ...patentCase, inventionDraft: action.draft, disclosure: action.draft.text })),
        {
          id: stamp("job"),
          title: "撰写发明专利申请文件",
          status: "succeeded",
          at: action.draft.at,
          detail: `自检 ${action.draft.score} 分，${action.draft.claimCount} 条权利要求，引用 ${action.draft.priorArt.length} 篇对比文件${action.draft.revised ? "，已自动修订一轮" : ""}。`,
          durationMs: 0,
        },
      );
    case "revise-invention-draft": {
      const last = action.draft.revisions?.at(-1);
      return pushJob(
        withCase(state, action.caseId, (patentCase) => ({ ...patentCase, inventionDraft: action.draft, disclosure: action.draft.text })),
        {
          id: stamp("job"),
          title: "修改申请文件",
          status: "succeeded",
          at: action.draft.at,
          detail: `按要求修改 ${last?.applied.length ?? 0} 处，自检 ${last ? `${last.scoreBefore} → ${last.scoreAfter}` : action.draft.score} 分，${action.draft.claimCount} 条权利要求。`,
          durationMs: 0,
        },
      );
    }
    case "undo-invention-draft": {
      const draft = state.cases.find((item) => item.id === action.caseId)?.inventionDraft;
      const stack = draft?.undo ?? [];
      const previous = stack.at(-1);
      if (!draft || !previous) return state;
      const restored: InventionDraftState = { ...previous, undo: stack.slice(0, -1) };
      return pushJob(
        withCase(state, action.caseId, (patentCase) => ({ ...patentCase, inventionDraft: restored, disclosure: restored.text })),
        {
          id: stamp("job"),
          title: "撤销申请文件修改",
          status: "succeeded",
          at: new Date().toISOString(),
          detail: `已恢复到修改前的版本，自检 ${restored.score} 分，${restored.claimCount} 条权利要求。`,
          durationMs: 0,
        },
      );
    }
    case "radar-result": {
      const sub = state.subscriptions.find((item) => item.id === action.id);
      if (!sub) return state;
      const seen = [...new Set([...(sub.seen ?? []), ...action.hits.map((hit) => hit.pn.replace(/[A-Z]\d?$/, ""))])].slice(-3000);
      const known = new Set((sub.hits ?? []).map((hit) => hit.pn.replace(/[A-Z]\d?$/, "")));
      const fresh = action.hits.filter((hit) => !known.has(hit.pn.replace(/[A-Z]\d?$/, "")));
      const lastStatus: "ok" | "error" = action.ok ? "ok" : "error";
      return pushJob(
        {
          ...state,
          subscriptions: state.subscriptions.map((item) =>
            item.id === action.id
              ? { ...item, lastRunAt: action.ranAt, lastStatus, lastDetail: action.detail, seen, hits: [...fresh, ...(item.hits ?? [])].slice(0, 120) }
              : item,
          ),
        },
        {
          id: stamp("job"),
          title: `专利雷达：${sub.name}`,
          status: action.ok ? "succeeded" : "blocked",
          at: action.ranAt,
          detail: action.detail,
          durationMs: 0,
        },
      );
    }
    case "toggle-sub":
      return { ...state, subscriptions: state.subscriptions.map((item) => (item.id === action.id ? { ...item, enabled: !item.enabled } : item)) };
    case "remove-sub":
      return { ...state, subscriptions: state.subscriptions.filter((item) => item.id !== action.id) };
    case "toggle-skill":
      return {
        ...state,
        skills: state.skills.map((skill) => (skill.id === action.id && !skill.lockedReason ? { ...skill, enabled: !skill.enabled } : skill)),
      };
    case "save-model": {
      const remember = action.rememberKey && action.key.trim().length > 0;
      return {
        ...state,
        model: {
          baseUrl: action.baseUrl.trim(),
          modelId: action.modelId.trim(),
          secret: remember ? action.key.trim() : "",
          keyHint: remember ? `只保存在这台浏览器 · 末四位 ${action.key.trim().slice(-4)}` : "未保存密钥",
        },
      };
    }
    case "forget-key":
      return { ...state, model: { ...state.model, secret: "", keyHint: "未保存密钥" } };
    case "export-done":
      return pushJob(
        withCase(state, action.caseId, (patentCase) => ({
          ...patentCase,
          stage: patentCase.issues.some((issue) => issue.level === "severe") ? "IN_REVIEW" : "READY_EXPORT",
          audit: [{ id: stamp("audit"), at: new Date().toISOString(), action: "导出 DOCX 草稿", detail: "下载的是草稿，不是提交快照。" }, ...patentCase.audit],
          messages: [...patentCase.messages, { id: stamp("msg"), role: "trace", at: new Date().toISOString(), text: "已导出 DOCX 草稿。文件没有标记为已提交。" }],
        })),
        {
          id: stamp("job"),
          title: "导出交底草稿",
          status: "succeeded",
          at: new Date().toISOString(),
          detail: "DOCX 已在浏览器生成。",
          durationMs: 20,
        },
      );
    case "add-knowledge": {
      const text = action.text.trim();
      if (!text) return state;
      const doc: KnowledgeDoc = {
        id: stamp("know"),
        name: action.name,
        kind: action.kind,
        text,
        chars: text.length,
        at: new Date().toISOString(),
      };
      return { ...state, knowledge: [doc, ...(state.knowledge ?? []).filter((item) => !(item.name === doc.name && item.text === doc.text))] };
    }
    case "remove-knowledge":
      return { ...state, knowledge: (state.knowledge ?? []).filter((item) => item.id !== action.id) };
    case "queue-knowledge": {
      const items = action.ids
        .map((id) => (state.knowledge ?? []).find((item) => item.id === id) ?? builtInKnowledge(id))
        .filter((item): item is KnowledgeDoc => Boolean(item))
        .map((item) => ({ name: item.name, kind: item.kind === "pdf" ? "pdf" as const : "text" as const, text: item.text }));
      return { ...state, knowledgeQueue: [...(state.knowledgeQueue ?? []), ...items] };
    }
    case "clear-knowledge-queue":
      return { ...state, knowledgeQueue: [] };
    case "pin-case":
      return withCase(state, action.caseId, (patentCase) => ({ ...patentCase, pinned: action.pinned }));
    case "restore-case": {
      if (state.cases.some((patentCase) => patentCase.id === action.patentCase.id)) return state;
      const cases = [...state.cases];
      const restored = normalizeCase(action.patentCase);
      cases.splice(Math.min(Math.max(action.index ?? 0, 0), cases.length), 0, restored);
      const activeCaseId = action.activate || !state.activeCaseId ? restored.id : state.activeCaseId;
      return { ...state, cases, activeCaseId };
    }
    case "clear-cases":
      return { ...state, cases: [], activeCaseId: null };
    case "clear-chat":
      return withCase(state, action.caseId, (patentCase) => ({ ...patentCase, messages: [], ideas: patentCase.ideas.filter((idea) => idea.status === "pursued") }));
    case "add-memory": {
      const text = action.text.replace(/\s+/g, " ").trim().slice(0, 600);
      if (!text) return state;
      return withCase(state, action.caseId, (patentCase) => {
        const memory = patentCase.memory ?? [];
        if (memory.some((note) => note.text === text)) return patentCase;
        return { ...patentCase, memory: [...memory, { id: stamp("mem"), text, source: action.source ?? "user", at: new Date().toISOString() }].slice(-60) };
      });
    }
    case "update-memory": {
      const text = action.text.replace(/\s+/g, " ").trim().slice(0, 600);
      return withCase(state, action.caseId, (patentCase) => ({
        ...patentCase,
        memory: text
          ? (patentCase.memory ?? []).map((note) => (note.id === action.id ? { ...note, text } : note))
          : (patentCase.memory ?? []).filter((note) => note.id !== action.id),
      }));
    }
    case "remove-memory":
      return withCase(state, action.caseId, (patentCase) => ({ ...patentCase, memory: (patentCase.memory ?? []).filter((note) => note.id !== action.id) }));
    case "wipe":
      return seed();
    default:
      return state;
  }
}

function generateDraft(state: Persisted, caseId: string): Persisted {
  const current = state.cases.find((patentCase) => patentCase.id === caseId);
  if (!current) return state;
  const started = performance.now();
  const mode = current.claimMode === "narrow" ? "narrow" : "broad";
  const claims = buildClaims(current.facts, mode);
  if (claims.length === 0) {
    const blocked: PatentCase = {
      ...current,
      stage: "FACTS_PENDING",
      messages: [...current.messages, { id: stamp("msg"), role: "assistant", at: new Date().toISOString(), text: "还没有已确认的处理步骤，所以没有生成权利要求，也没有改写正文。" }],
    };
    return pushJob(
      { ...state, cases: state.cases.map((patentCase) => (patentCase.id === caseId ? { ...blocked, issues: buildIssues(blocked, PUBLICATIONS) } : patentCase)) },
      { id: stamp("job"), title: "生成交底草稿", status: "blocked", at: new Date().toISOString(), detail: "缺少已确认的处理步骤。", durationMs: Math.round(performance.now() - started) },
    );
  }
  const figures = current.figures.length ? current.figures : defaultFigures(current.facts);
  let next: PatentCase = { ...current, claims, figures };
  next = { ...next, disclosure: renderDisclosure(next), draftedFrom: confirmedKey(next.facts) };
  const narrowed = buildClaims(next.facts, "narrow");
  const hasParameter = next.facts.some((fact) => fact.status === "confirmed" && fact.kind === "parameter");
  const proposals =
    mode === "broad" && hasParameter
      ? [
          {
            id: "proposal-narrow",
            title: "把具体参数移出独立权利要求",
            detail: "独立权利要求目前写进了具体参数。建议独立项只保留处理路径，参数改写到从属项。这是撰写范围建议，不是授权可能性。",
            status: "open" as const,
            claims: narrowed,
          },
        ]
      : current.proposals.filter((proposal) => proposal.status !== "open");
  const version: VersionSnap = {
    id: `v${current.versions.length + 1}`,
    label: `v${current.versions.length + 1}`,
    at: new Date().toISOString(),
    actor: "本地证据流程",
    disclosure: next.disclosure,
    claimsText: claimsToText(claims),
    reason: "按当前已确认事实重新生成。",
  };
  next = {
    ...next,
    proposals,
    versions: [...current.versions, version],
    stage: "DISCLOSURE_DRAFTED",
    messages: [
      ...current.messages,
      { id: stamp("msg"), role: "trace", at: version.at, text: "已根据已确认事实生成交底书、权利要求和附图骨架。未确认事实没有写入正文。" },
    ],
    audit: [{ id: stamp("audit"), at: version.at, action: "生成草稿", detail: version.label }, ...current.audit],
  };
  next = { ...next, issues: buildIssues(next, PUBLICATIONS) };
  if (next.issues.some((issue) => issue.level === "severe")) next = { ...next, stage: "IN_REVIEW" };
  return pushJob(
    { ...state, cases: state.cases.map((patentCase) => (patentCase.id === caseId ? next : patentCase)), dockTab: "draft" },
    {
      id: stamp("job"),
      title: "生成交底草稿",
      status: "succeeded",
      at: version.at,
      detail: `${next.title} 已生成 ${version.label}。`,
      durationMs: Math.max(1, Math.round(performance.now() - started)),
    },
  );
}

function resolveProposal(state: Persisted, action: Extract<Action, { type: "resolve-proposal" }>): Persisted {
  return withCase(state, action.caseId, (patentCase) => {
    const proposal = patentCase.proposals.find((item) => item.id === action.proposalId);
    if (!proposal || proposal.status !== "open") return patentCase;
    const at = new Date().toISOString();
    if (action.decision === "rejected") {
      return {
        ...patentCase,
        proposals: patentCase.proposals.map((item) => (item.id === proposal.id ? { ...item, status: "rejected" } : item)),
        audit: [{ id: stamp("audit"), at, action: "拒绝修改提案", detail: proposal.title }, ...patentCase.audit],
        messages: [...patentCase.messages, { id: stamp("msg"), role: "user", at, text: `拒绝提案：${proposal.title}` }],
      };
    }
    const claims = proposal.claims;
    let next: PatentCase = { ...patentCase, claims, claimMode: "narrow" };
    next = { ...next, disclosure: renderDisclosure(next) };
    const version: VersionSnap = {
      id: `v${patentCase.versions.length + 1}`,
      label: `v${patentCase.versions.length + 1}`,
      at,
      actor: "用户接受提案",
      disclosure: next.disclosure,
      claimsText: claimsToText(claims),
      reason: proposal.title,
    };
    next = {
      ...next,
      versions: [...patentCase.versions, version],
      proposals: patentCase.proposals.map((item) => (item.id === proposal.id ? { ...item, status: "accepted" } : item)),
      stage: "IN_REVIEW",
      audit: [{ id: stamp("audit"), at, action: "接受修改提案", detail: `${proposal.title}，生成 ${version.label}` }, ...patentCase.audit],
      messages: [...patentCase.messages, { id: stamp("msg"), role: "trace", at, text: `已接受提案并生成 ${version.label}。正文没有被静默覆盖，上一版仍可在差异里查看。` }],
    };
    return { ...next, issues: buildIssues(next, PUBLICATIONS) };
  });
}

export function searchPublications(query: string, scope: SearchScope): Publication[] {
  const needle = query.trim();
  return PUBLICATIONS.filter((publication) => {
    if (scope === "private") return false;
    if (!needle) return true;
    const haystack = `${publication.number} ${publication.title} ${publication.text} ${publication.claimsText} ${publication.assignee}`;
    return haystack.includes(needle);
  });
}

export function activeCase(state: Persisted): PatentCase | null {
  return state.cases.find((patentCase) => patentCase.id === state.activeCaseId) ?? null;
}
