import { READ_SYSTEM, SKILL_SYSTEM } from "./patent-skill.ts";
import { INVENTION_SYSTEM, buildDraftPrompt } from "./invention-draft.ts";
import type { PriorArtRef } from "./invention-draft.ts";
import { detectDomain, domainHint } from "./patent-library.ts";
import type { ChatMessage } from "./model.ts";
import { compactDialog, environmentBlock, selectMaterial } from "./context-budget.ts";

export type SlashIntent = "auto" | "ideas" | "disclosure" | "search" | "read" | "chart" | "chat" | "draft" | "create" | "outline" | "revise";

/** 一句话创作那一轮的过程行以它开头；选定题目时据此判断这件案子是“创作”出来的，走大纲而不是追问交底事实。 */
export const CREATE_TRACE_PREFIX = "专利技能：一句话创作";

export interface PackedMaterial {
  name: string;
  kind: "pdf" | "text";
  text: string;
}

export const SLASH_SKILLS: Array<{ command: string; intent: SlashIntent; label: string; hint: string }> = [
  { command: "/创作", intent: "create", label: "一句话创作", hint: "只给领域：检索专利和论文找创新点，出题目让你选" },
  { command: "/一键成稿", intent: "auto", label: "一键成稿", hint: "不追问：自动检索选题、出大纲、写完整稿并生成 Word" },
  { command: "/挖点", intent: "ideas", label: "挖点", hint: "从材料里对话找发明点" },
  { command: "/交底书", intent: "disclosure", label: "交底书", hint: "确认事实后再成稿" },
  { command: "/大纲", intent: "outline", label: "大纲", hint: "按选定题目设计大纲目录，再写全文" },
  { command: "/发明稿", intent: "draft", label: "发明稿", hint: "检索对比文件后写完整申请文件并自检" },
  { command: "/修改", intent: "revise", label: "修改", hint: "成稿后定点修改：放宽权利要求、补实施例、补公式定义，可撤销" },
  { command: "/查新", intent: "search", label: "查新", hint: "只给检索式和线索" },
  { command: "/读专利", intent: "read", label: "解读", hint: "把公开文本讲清楚" },
  { command: "/对照表", intent: "chart", label: "对照表", hint: "特征对上证据" },
];

const INTENT_TASK: Record<SlashIntent, string> = {
  auto: "全自动成稿：发明人要求不要询问，直接依次完成选题、大纲和完整申请文件初稿。",
  revise: "成稿后修改：按发明人的要求对已有申请文件做定点修改，只输出补丁，其余内容不动。",
  create: [
    "一句话创作。发明人只给了一个技术领域或一句话需求，没有自己的方案材料，需要你主动找创新点。按顺序做：",
    "1) 用联网工具检索至少三轮：该领域近三年的中国发明专利（优先 CN 公开号，可查 Google Patents、CNIPA 公开信息）、相关论文或综述、行业公开的技术痛点；检索词要短，换角度检索，不要重复同一个词。",
    "2) 归纳现有技术的两三种主流做法和它们的共性缺陷，每条尽量用 [n] 标出依据的检索结果；检索没找到就直说，不要编专利号、论文名或数据。",
    "3) 给出 3 到 5 个候选发明题目，题目用规范写法「一种……的方法/装置/系统」。每个题目写清：要解决的技术问题、核心创新特征（具体到步骤、结构或算法环节，不能只写“智能化”“优化”）、预期技术效果（标“预期”）、与最接近现有技术的区别、需要发明人确认或实验验证的事项。",
    "4) 推荐其中一个并说明理由（新颖性空间、可实施性、保护范围）。",
    "5) 最后请发明人选一个题目，或告诉你想调整的方向；这一轮不要写大纲，也不要写申请文件全文。",
    "json 的 patentPoints 必须逐个列出这些候选题目，title 填题目全称，pending 填待确认事项；title 字段填这件案子的简短主题。",
  ].join("\n"),
  outline: [
    "设计大纲。发明人已选定题目（见【发明人已选定】），他没有自己的实验材料。结合前面对话里的检索线索，自行设计这件发明的完整大纲目录，供发明人确认后成稿。按下面的目录写，每一项都要写出实际内容，不要只写标题：",
    "一、发明名称；二、技术领域（一句话）；三、背景技术（两三种现有做法及缺陷，引用前面检索到的线索，没有就按所属领域通用做法概述，不写公开号和占位标记）；四、要解决的技术问题；",
    "五、技术方案（按步骤或模块分条，写到具体结构、算法环节和关键参数；参数给建议取值范围并标“建议值，待实验确认”）；六、有益效果（与第三项的缺陷一一对应，标“预期”）；",
    "七、权利要求布局（独立权利要求 1 条写必要技术特征，从属权利要求 6 到 9 条，逐条写保护要点；需要时加一条装置或系统独立权利要求）；",
    "八、附图清单（图1、图2……每张写画什么、标哪些附图标记）；九、具体实施方式安排（至少两个实施例，写清各自的场景和参数差异）；十、需要发明人确认的事项（最多五条）。",
    "写完提醒发明人：可以直接改大纲再发回来，确认后点「按大纲写完整稿」或发送 /发明稿 生成全部申请文件。不要在这一轮写申请文件全文。",
  ].join("\n"),
  draft: "发明人想写发明稿，但材料还不够。先追问技术问题、现有做法和缺陷、核心步骤和关键参数，每次最多两个问题；材料够了提醒发明人再发 /发明稿。",
  ideas: "对话挖发明点。先给 3 到 5 个候选点，每点写清技术问题、核心特征、效果、待确认事项。材料没有的实验、参数、效果不要编。每次最多问两个关键问题，等发明人选定后再成稿。",
  disclosure: "按交底技能推进：扫描事实、确认边界、预览保护主题。事实不够时不要写成完整交底书。",
  search: "只产出短检索式和查新思路。不要给新颖性或授权结论，不要假装已核验对比文件。",
  read: "只解读用户指定的已有资料，严格按本轮要求的范围、长度与格式回答。没有要求展开时，不补充启发、候选点、参考参数或追问；缺失内容如实说明，不进入创作或成稿流程。",
  chart: "把已确认特征与材料做字面对照。找不到就写未找到。这不是法律结论。",
  chat: "顺着发明人上一轮继续。有附件就紧扣附件；没有附件就追问缺的事实，不要编造实验。",
};

export function parseSlash(text: string): { intent: SlashIntent; rest: string; command?: string } {
  const trimmed = text.trim();
  const hit = SLASH_SKILLS.find((item) => trimmed === item.command || trimmed.startsWith(`${item.command} `) || trimmed.startsWith(`${item.command}\n`));
  if (!hit) return { intent: "chat", rest: trimmed };
  return { intent: hit.intent, rest: trimmed.slice(hit.command.length).trim(), command: hit.command };
}

/**
 * What the inventor actually asked for on top of /发明稿. The composer fills an empty command with
 * defaultPrompt(); that canned text ("请先问我……材料够了再写发明稿") is a UI placeholder, not a requirement.
 * Appended as 【发明人补充要求】 it made the drafting model ask questions instead of writing the application.
 */
export function draftExtra(userText: string): string {
  const value = userText.trim();
  if (!value) return "";
  const canned = new Set([defaultPrompt("draft", true), defaultPrompt("draft", false)]);
  return canned.has(value) ? "" : value;
}

/**
 * 一句话创作：发明人只说“帮我写一个××领域的发明专利”，没有自己的方案。识别出来就走 /创作：
 * 联网检索专利和论文 → 候选题目 → 选定后出大纲 → 按大纲写全文。只认短句：写了技术方案的描述
 * （我的方案、现有做法、核心步骤……）仍按挖点处理，问“怎么写专利”的问题也不算。
 */
const CREATE_PATTERN = /(?:写|撰写|生成|出|做|创作|构思|申请|搞|来)(?:一|1|几)?(?:个|份|篇|件|项)?.{0,40}?专利/;
const SCHEME_WORDS = /(?:我的方案|现有做法|核心步骤|技术方案[:：]|包括以下|实施例|权利要求\s*1|步骤[一二三123])/;
const QUESTION_WORDS = /(?:怎么|怎样|如何|什么是|为什么|是什么|多少钱|费用|流程是)/;

export function detectCreateRequest(text: string): boolean {
  const value = text.trim();
  if (!value || value.startsWith("/") || value.length > 120) return false;
  if (SCHEME_WORDS.test(value) || QUESTION_WORDS.test(value)) return false;
  return CREATE_PATTERN.test(value);
}

/**
 * “总结一下附件”“解读第 4 节”“Summarize Section 4”是读材料，不是挖发明点：有材料时走 /解读，按问题节选并标注页码。
 * 同时要求写交底书、挖点、起草的，仍按原来的技能处理。
 */
const READ_PATTERN =
  /(?:阅读|概述|总结|概括|归纳|摘要|解读|讲解|梳理|提炼|读一下|读懂|讲讲|介绍一下|说明一下|主要内容|讲了什么|说了什么|第\s*\d+\s*[节章])|\b(?:summari[sz]e|summary|explain|overview|tl;?dr|walk me through|key (?:points|findings|contributions)|what (?:does|did) (?:the|this) (?:paper|document|article|section)|section\s*\d+(?:\.\d+)*)\b/i;
const WRITE_PATTERN = /(?:写|撰写|起草|生成|挖掘|挖点|发明点|交底书|申请文件|专利稿|发明稿|权利要求书)|\b(?:draft|write|patent application)\b/i;

function negatesWriting(prefix: string): boolean {
  if (/(?:不能不|不得不|不要不|并非不|不是不)\s*$/.test(prefix)) return false;
  return /(?:不要|不必|不用|不需要|无需|无须|别|勿|不)(?:\s*(?:再|先|继续|重新|帮我|替我|给我|为我|进行))*\s*$/.test(prefix);
}

function hasPositiveWriting(text: string): boolean {
  return text.split(/[，,。；;！？!?\n]|但是?|不过|然而|而是|然后|随后|接着/).some((clause) => {
    if (!WRITE_PATTERN.test(clause)) return false;
    const actions = [...clause.matchAll(/撰写|改写|起草|生成|挖掘|挖点|写|\b(?:draft|write)\b/gi)];
    if (!actions.length) {
      const target = WRITE_PATTERN.exec(clause)!;
      return !negatesWriting(clause.slice(0, target.index));
    }
    let previousEnd = 0;
    let negated = false;
    for (const action of actions) {
      const prefix = clause.slice(previousEnd, action.index);
      // “不要生成全文或起草权利要求” shares a negation, but a new positive
      // instruction (including one after an unrelated “不要联网”) does not.
      negated = negatesWriting(prefix) || (negated && /(?:或|和|及|以及|、)\s*$/.test(prefix));
      if (!negated) return true;
      previousEnd = action.index + action[0].length;
    }
    return false;
  });
}

export function detectReadRequest(text: string): boolean {
  const value = text.trim();
  if (!value || value.startsWith("/")) return false;
  return READ_PATTERN.test(value) && !hasPositiveWriting(value);
}
/** 从“帮我写一个智慧农业领域的发明专利”里取出“智慧农业”，取不到返回空串。 */
export function createTopic(text: string): string {
  const value = (parseSlash(text).rest || text).trim();
  const clean = (raw: string) => {
    const topic = raw
      .replace(/^(?:一个|一份|一篇|一件|一项|几个|个|份|篇|件|项|关于)+/, "")
      .replace(/的$/, "")
      .trim();
    return topic.length >= 2 && !/^(?:完整|全套|全部|详细|具体|发明|专利|发明专利)+$/.test(topic) ? topic.slice(0, 80) : "";
  };
  // Read an explicitly named subject before interpreting generic words such as “完整专利”.
  const directed = /(?:^|[。！？；\n])\s*(?:请)?(?:(?:选择|选定|确定|改为|更换|采用)\s*)?(?:围绕|针对|主题\s*[：:]|题目\s*[：:]|发明名称\s*[：:]|关于)\s*([^，。！？；\n]{2,80})/.exec(value);
  if (directed) {
    const topic = clean(directed[1]);
    if (topic) return topic;
  }
  const field = /(.{2,30}?)(?:领域|方向|行业|方面)/.exec(value);
  if (field) {
    const topic = clean(field[1].replace(/^.*(?:写|撰写|生成|做|创作|构思|申请|关于|针对)(?:一|1)?(?:个|份|篇|件|项)?/, ""));
    if (topic) return topic;
  }
  const subject = /(?:写|撰写|生成|做|创作|构思|申请)(?:一|1)?(?:个|份|篇|件|项)?(?:关于)?(.{2,30}?)的?(?:发明)?专利/.exec(value);
  return subject ? clean(subject[1]) : "";
}

export function defaultPrompt(intent: SlashIntent, hasMaterial: boolean): string {
  // /修改 不带要求时由修改流程给出用法说明，不替发明人编一个修改要求。
  if (intent === "revise") return "";
  if (intent === "auto") return "按照你的想法来，不要询问我，直接帮我完成选题、大纲和完整的发明专利申请文件初稿。";
  if (intent === "outline") return "请按我选定的题目设计完整的大纲目录：技术方案、权利要求布局、附图清单和实施例安排，参数写建议值并标明待确认。";
  if (!hasMaterial) {
    if (intent === "create") return "我想写一件发明专利，但还没定方向。请先问我感兴趣的技术领域或行业，定下来后再去检索专利和论文找创新点。";
    if (intent === "draft") return "我还没有给交底材料。请先问我：要解决的技术问题、现在的做法和缺陷、我的核心步骤和关键参数，材料够了再写发明稿。";
    if (intent === "read") return "我还没有上传要读的文本。请先提醒我上传 PDF 或粘贴要解读的文本。";
    if (intent === "search") return "还没有材料。先根据我描述的技术主题给出检索式草案，并问我补充关键词。";
    if (intent === "chart") return "还没有足够材料做对照。请告诉我需要先确认哪些特征。";
    if (intent === "disclosure") return "还没有交底材料。请先问我技术问题、现有做法和想保护的点。";
    return "我还没有上传材料。请先问我：要解决什么问题、现在怎么做、卡在哪里、有没有实验或图纸。不要编造数据。";
  }
  if (intent === "create") return "请根据已有材料所在的技术领域联网检索相关专利和论文，找出创新点，给我 3 到 5 个候选发明题目。";
  if (intent === "draft") return "请根据已有材料（附件和对话里我给的内容）和已确认事实，撰写完整的发明专利申请文件草稿。";
  if (intent === "ideas") return "请根据已有材料（附件和对话里我给的内容）挖候选发明点，用对话帮我判断哪一个值得写成发明专利。";
  if (intent === "disclosure") return "请按中国专利交底技能处理已有材料（附件和对话里我给的内容），先整理可写入正文的事实和候选点。";
  if (intent === "search") return "请根据已有材料（附件和对话里我给的内容）给出查新检索式，不要下法律结论。";
  if (intent === "read") return "请解读已有材料（附件和对话里我给的内容），概述技术问题、核心方法及原文记载的结论，不补充未记载的内容。";
  if (intent === "chart") return "请把已有材料（附件和对话里我给的内容）里的技术特征做成对照提纲。";
  return "请根据已有材料（附件和对话里我给的内容）继续帮我找发明点和缺的事实。";
}

/** 对话里发明人累计写下的正文达到这个字数（不计空白和斜杠命令），就当作已经给过交底材料。 */
export const DIALOG_MATERIAL_MIN_CHARS = 40;

/**
 * 发明人常常不上传附件，而是直接在对话里描述技术方案。只看附件会让单独发出的 /挖点、/交底书、/查新
 * 拿到“还没有材料”的默认提示，而模型在 history 里又能看到交底内容，前后矛盾。
 * 案件记忆（发明人确认过的要点）也算材料；助手和 trace 消息不算。
 */
export function dialogHasMaterial(messages: readonly ChatMessage[] | undefined, memory: readonly { text: string }[] = []): boolean {
  if (memory.some((note) => note.text.trim().length > 0)) return true;
  let chars = 0;
  for (const message of messages ?? []) {
    if (message.role !== "user") continue;
    chars += parseSlash(message.text).rest.replace(/s+/g, "").length;
    if (chars >= DIALOG_MATERIAL_MIN_CHARS) return true;
  }
  return false;
}

export function clipText(text: string, cap: number): string {
  const value = text.trim();
  if (value.length <= cap) return value;
  const head = Math.max(24, Math.floor(cap * 0.72));
  const tail = Math.max(16, cap - head - 12);
  return `${value.slice(0, head)}\n…[中间省略]…\n${value.slice(-tail)}`;
}

export function packMaterials(materials: PackedMaterial[], cap = 12000): string {
  if (materials.length === 0) return "（还没有附件材料）";
  const blocks = materials.map((item) => {
    const body = item.text.trim() || "（这份文件没有抽出文字层）";
    return `### 《${item.name}》·${item.kind}·${item.text.trim().length}字\n${body}`;
  });
  const joined = blocks.join("\n\n");
  if (joined.length <= cap) return joined;
  const per = Math.max(400, Math.floor(cap / materials.length) - 80);
  return materials
    .map((item) => {
      const body = clipText(item.text.trim() || "（这份文件没有抽出文字层）", per);
      return `### 《${item.name}》·${item.kind}·${item.text.trim().length}字\n${body}`;
    })
    .join("\n\n");
}

export function dialogHistory(messages: ChatMessage[], cap = 8): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter((item): item is ChatMessage & { role: "user" | "assistant" } => item.role === "user" || item.role === "assistant")
    .slice(-cap)
    .map((item) => ({ role: item.role, content: clipText(item.text, 1500) }));
}

export function buildChatMessages(input: {
  materials: PackedMaterial[];
  history: ChatMessage[];
  userText: string;
  intent: SlashIntent;
  pursued?: string[];
  facts?: string[];
  priorArt?: PriorArtRef[];
  chosenPoint?: { title: string; problem?: string; feature?: string; effect?: string };
  /** /发明稿 的领域撰写指引（由 draft-run 识别领域后生成）。 */
  domainGuide?: string;
  /** 案件记忆与已确认事实，每轮注入。 */
  memory?: string[];
  /** 本轮能否联网（写进运行环境说明）。 */
  tools?: boolean;
}): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const hasText = input.materials.some((item) => item.text.trim().length > 0) || (input.facts?.length ?? 0) > 0;
  if (input.intent === "draft" && hasText) {
    const extra = draftExtra(input.userText);
    const prompt = buildDraftPrompt({
      title: input.chosenPoint?.title || input.pursued?.find((item) => item.trim()),
      material: packMaterials(input.materials, 30000),
      confirmedFacts: input.facts,
      chosenPoint: input.chosenPoint,
      priorArt: input.priorArt,
      domainGuide: input.domainGuide,
    });
    return [
      { role: "system", content: INVENTION_SYSTEM },
      { role: "user", content: `${environmentBlock({ intent: "draft", materials: input.materials, turns: 0, tools: false })}\n\n${extra ? `${prompt}\n\n【发明人补充要求】${extra}` : prompt}` },
    ];
  }
  const compact = compactDialog(input.history, { budget: 9000, keep: 10 });
  const history = compact.recent;
  const pursued = input.pursued?.filter((item) => item.trim()) ?? [];
  const hint = input.intent === "chat" || input.intent === "read" ? "" : domainHint(detectDomain([materialsText(input.materials), input.userText].join("\n")));
  const user = [
    `【任务】${INTENT_TASK[input.intent]}`,
    environmentBlock({ intent: input.intent, materials: input.materials, turns: input.history.filter((item) => item.role !== "trace").length, tools: Boolean(input.tools) }),
    input.memory?.length ? `【案件记忆（发明人确认过的要点，优先遵守）】\n${input.memory.map((item, index) => `${index + 1}. ${item}`).join("\n")}` : "",
    compact.summary ? `【更早的对话摘要（${compact.dropped} 条，已压缩）】\n${compact.summary}` : "",
    `【附件】\n${selectMaterial(input.materials, [input.userText, ...pursued].join(" "), 12000) ?? packMaterials(input.materials)}`,
    pursued.length ? `【发明人已选定】${pursued.join("；")}` : "【发明人已选定】无",
    hint,
    `【用户】${input.userText.trim() || defaultPrompt(input.intent, input.materials.some((item) => item.text.trim().length > 0))}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return [{ role: "system", content: input.intent === "read" ? READ_SYSTEM : SKILL_SYSTEM }, ...history, { role: "user", content: user }];
}

export function materialsText(materials: PackedMaterial[]): string {
  return materials.map((item) => item.text.trim()).filter(Boolean).join("\n\n");
}

/**
 * What a case already knows that the drafting prompt should use: facts the inventor confirmed (or typed
 * in themselves) and the first invention point they chose to pursue.
 */
export function draftContext(
  patentCase?: {
    facts?: Array<{ statement: string; status: string; origin: string }>;
    ideas?: Array<{ title: string; problem: string; feature: string; effect: string; status: string }>;
  } | null,
): { facts: string[]; chosenPoint?: { title: string; problem: string; feature: string; effect: string } } {
  const facts = (patentCase?.facts ?? [])
    .filter((fact) => fact.status === "confirmed" || (fact.origin === "inventor" && fact.status !== "rejected"))
    .map((fact) => fact.statement.trim())
    .filter((statement) => statement.length >= 4);
  const idea = (patentCase?.ideas ?? []).find((item) => item.status === "pursued");
  return {
    facts: [...new Set(facts)].slice(0, 40),
    chosenPoint: idea ? { title: idea.title, problem: idea.problem, feature: idea.feature, effect: idea.effect } : undefined,
  };
}

/** Name of the material packed from the inventor's chat lines. It is a container, never a topic in itself. */
export const CONVERSATION_MATERIAL_NAME = "对话交底.md";

/** 一句话创作选定题目后，AI 设计的大纲存成这个名字的材料，/发明稿 据此成稿。它是容器，不是发明名称。 */
export const OUTLINE_MATERIAL_NAME = "创作大纲.md";

/** What an invention title ends on: the claimed subject (…装置, …方法, …传感器). */
const SUBJECT_TAIL = /(?:装置|系统|方法|设备|结构|组件|机构|工艺|材料|组合物|电路|介质|模块|平台|芯片|算法|器|机|仪)$/;
/** A label the inventor put in front of a line; the words after it are the content. */
const LABEL_PREFIX = /^(?:发明名称|技术主题|主题|名称|题目|技术领域)\s*[：:]\s*/;

/** File names that only say what kind of document it is (交底.md, 技术交底书-v2.docx, 新建文档 (3).txt). */
const GENERIC_FILE_NAME =
  /^(?:(?:技术|发明|专利|项目)?(?:交底(?:书|材料|文件|稿)?|说明书?|材料|资料|文档|附件|草稿|初稿|稿件|新建文档|新建|未命名|无标题|副本)|untitled|document|doc|draft|disclosure|new|file|material|copy)$/i;

/**
 * The topic a file name carries, or "" when the name only labels the document type. Extensions, version
 * and copy suffixes and a trailing “技术交底书/说明书” label are dropped, so “雨水井截污装置交底书_v2.docx” gives
 * “雨水井截污装置”, while “交底.md” gives nothing and the topic is read from the text instead.
 */
export function topicFromFileName(name: string): string {
  let base = name.replace(/\.(?:pdf|txt|md|markdown|docx?|rtf|odt)$/i, "").trim();
  for (let round = 0; round < 3; round += 1) {
    const next = base
      .replace(/[\s_\-—–]*(?:[(（]\d+[)）]|副本|copy|v?\d+(?:\.\d+)*|终稿|定稿|修改稿|最终版?)$/i, "")
      .trim();
    if (next === base) break;
    base = next;
  }
  const stripped = base.replace(/[\s_\-—–]*的?(?:技术)?(?:交底(?:书|材料|文件|稿)?|说明书)$/, "").trim();
  const core = stripped.replace(/[\s_\-—–.()（）[\]【】]+/g, "");
  if (!core || GENERIC_FILE_NAME.test(core)) return "";
  if (!/[\u4e00-\u9fffA-Za-z]{2,}/.test(core)) return "";
  return stripped;
}

export function titleFromMaterials(materials: PackedMaterial[], fallback: string): string {
  // A file name names the invention only when it is more than a document-type label (交底.md, 材料.docx).
  for (const item of materials) {
    if (!item.name || /^粘贴材料/.test(item.name) || item.name === CONVERSATION_MATERIAL_NAME || item.name === OUTLINE_MATERIAL_NAME) continue;
    const named = topicFromFileName(item.name);
    if (named) return named.slice(0, 28);
  }
  // An invention is named “一种…装置/方法”. The first such clause that ends on a subject is the topic;
  // a clause like “一种常见做法是人工清掏” describes the background and is skipped.
  for (const match of fallback.matchAll(/一种[^，。；;,、：:（(\n]{3,40}/g)) {
    const clause = match[0].trim();
    if (SUBJECT_TAIL.test(clause)) return clause.slice(0, 28);
  }
  // A line that is only a bracketed note (【测试案件…】, 【待确认…】) labels the text rather than naming the invention.
  const line = fallback
    .split(/[\n。]/)
    .map((item) => item.trim().replace(LABEL_PREFIX, "").trim())
    .find((item) => item.length >= 6 && !/^【[^】]*】$/.test(item));
  return (line || "未命名技术主题").slice(0, 28);
}

/**
 * The inventor's own words from the chat, packed as one material for drafting. Only user lines count:
 * assistant replies and trace lines are model output, and a bare slash command carries no facts.
 * Lines already contained in the attached materials are skipped so nothing reaches the model twice.
 */
export function conversationMaterial(
  history: ReadonlyArray<{ role: string; text: string }>,
  existingCorpus = "",
): PackedMaterial | null {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const message of history) {
    if (message.role !== "user") continue;
    const text = message.text.trim();
    if (!text || /^\/\S+$/.test(text) || seen.has(text) || existingCorpus.includes(text)) continue;
    seen.add(text);
    lines.push(text);
  }
  return lines.length ? { name: CONVERSATION_MATERIAL_NAME, kind: "text", text: lines.join("\n\n") } : null;
}

/** 输入只是孤立斜杠或未写完的技能前缀（如 “/”“/发”）时返回 true；普通路径或带内容的命令返回 false。 */
export function isIncompleteSlash(text: string): boolean {
  const slash = parseSlash(text);
  return !slash.command && /^\/\S*$/.test(slash.rest) && SLASH_SKILLS.some((item) => item.command.startsWith(slash.rest));
}
