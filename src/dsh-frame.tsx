import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Composer } from "./composer.tsx";
import { ClickRipple, useListMotion } from "./fx.tsx";
import type * as ExportDocx from "./export-docx.ts";
import { reportSummary } from "./cnipa-format.ts";
import { activeCase } from "./model.ts";
import type { DockTab, PatentIdea, View } from "./model.ts";
import { SKILL_STEPS } from "./patent-skill.ts";
import { readUserFile, type PendingFile } from "./read-user-file.ts";
import { runPatentTurn } from "./skill-run.ts";
import { CREATE_TRACE_PREFIX, OUTLINE_MATERIAL_NAME, createTopic, defaultPrompt, detectCreateRequest, dialogHasMaterial, draftContext, isIncompleteSlash, parseSlash, SLASH_SKILLS, titleFromMaterials, type SlashIntent, detectReadRequest } from "./skill-turn.ts";
import { detectPackageRequest, detectReviseRequest } from "./draft-revise.ts";
import { useStore } from "./store.tsx";
import { ReplyBody } from "./reply-body.tsx";
import { ClaimChart, DisclosureView, KindMark, formatTime } from "./widgets.tsx";
import { Glyph } from "./glyph.tsx";
import { KnowledgePage, ModelsPage, RadarPage, SearchPage, SettingsPage } from "./pages.tsx";
import { PrimerPage } from "./primer.tsx";
import { markKnowledgeBack } from "./ui-nav.ts";
import { SessionList } from "./session-list.tsx";
import { MemoryPanel } from "./memory-panel.tsx";
import { detectAutoRequest } from "./auto-flow.ts";
import { detectRunKind, runProgress } from "./run-progress.ts";
import { RunProgressCard } from "./run-progress-card.tsx";
import { CommandPalette, type PaletteCommand } from "./command-palette.tsx";
import { sizeLabel, pageCount } from "./page-count.ts";
import { UsageNotice } from './usage-notice.tsx';
import { GITHUB_MARK_PATH, REPOSITORY_URL } from './site-info.ts';

// docx (and the export pipeline built on it) is several MB of source: load it only when the user actually exports.
const PackageCard = lazy(() => import("./package-card.tsx").then((mod) => ({ default: mod.PackageCard })));
const DraftDetailPanel = lazy(() => import("./draft-detail-panel.tsx").then(mod => ({default:mod.DraftDetailPanel})));
const downloadDisclosure: typeof ExportDocx.downloadDisclosure = async (...args) => (await import("./export-docx.ts")).downloadDisclosure(...args);

type PaneId = DockTab | "files" | "memory";

const PANES: Array<{ id: PaneId; title: string; hint: string; icon: string }> = [
  { id: "files", title: "申请文件", hint: "分件下载 Word，或一键打包", icon: "doc" },
  { id: "memory", title: "上下文与记忆", hint: "案件记忆、资料和上下文用量", icon: "book" },
  { id: "material", title: "材料", hint: "查看原文并定位到句子", icon: "file" },
  { id: "draft", title: "交底书", hint: "内置技能写出的草稿", icon: "doc" },
  { id: "claims", title: "权利要求", hint: "只使用已确认的事实", icon: "tree" },
  { id: "chart", title: "查新", hint: "字面对照，不是法律结论", icon: "chart" },
  { id: "figures", title: "附图", hint: "可编辑的步骤骨架", icon: "image" },
  { id: "diff", title: "差异", hint: "比较相邻版本", icon: "diff" },
  { id: "review", title: "审核", hint: "自检留下的问题", icon: "check" },
];

const HINTS: Array<{ title: string; desc: string; command: string; text: string }> = [
  { title: "只有领域，先帮我起题", desc: "检索专利和论文找创新点，出几个题目让你选", command: "/创作", text: "/创作 帮我写一个智慧农业领域的发明专利" },
  { title: "从论文里挖发明点", desc: "拖入论文、报告或交底材料，对话找出可保护的点", command: "/挖点", text: "/挖点 " },
  { title: "整理技术交底书", desc: "先确认技术事实，再写成交底书草稿", command: "/交底书", text: "/交底书 " },
  { title: "生成全套申请文件", desc: "检索对比文件后写说明书、权利要求书并自检", command: "/发明稿", text: "/发明稿 " },
];

const FLOW = ["选定主题", "检索与挖点", "撰写说明书与权利要求", "生成附图", "自检并导出 Word"];

/** Pointer-follow spotlight for hint cards: writes the cursor position into CSS vars. */
function spotlight(event: { currentTarget: HTMLElement; clientX: number; clientY: number }) {
  const box = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty("--mx", `${event.clientX - box.left}px`);
  event.currentTarget.style.setProperty("--my", `${event.clientY - box.top}px`);
}

/** Tool destinations shown in the sidebar. Every entry maps to a page the frame can render. */
const NAV: Array<{ view: View; label: string; icon: string }> = [
  { view: "radar", label: "技术雷达", icon: "radar" },
  { view: "search", label: "专利检索", icon: "search" },
  { view: "knowledge", label: "专利知识库", icon: "book" },
  { view: "primer", label: "发明入门", icon: "info" },
];

const VIEW_LABEL: Partial<Record<View, string>> = {
  radar: "技术雷达",
  search: "专利检索",
  knowledge: "专利知识库",
  primer: "发明入门",
  settings: "设置",
  models: "模型与工具",
};

const SIDEBAR_KEY = "patentflow.sidebar.collapsed";
const NARROW_QUERY = "(max-width: 800px)";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

function isNarrow(): boolean {
  return typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches;
}

const MODEL_FAIL_PREFIX = "当前模型没有完成这一步";

function lastIndexWhere<T>(items: readonly T[], test: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) if (test(items[i])) return i;
  return -1;
}

function userTextBefore(messages: readonly { role: string; text: string }[], index: number): string {
  for (let i = index - 1; i >= 0; i -= 1) if (messages[i].role === "user") return messages[i].text;
  return "";
}

/** 当前时间（毫秒）。放在组件外，只在事件处理中调用，用来标记本轮开始的时间。 */
function currentTime(): number {
  return Date.now();
}

export function DshFrame() {
  const { state, view, setView, dispatch, notify, toast } = useStore();
  const current = activeCase(state);
  const chatting = view === "case" && current;
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  /** 本轮开始的时间：进度只统计这之后的进度记录。 */
  const [runSince, setRunSince] = useState(0);
  const [rightOpen, setRightOpen] = useState(false);
  const [pane, setPane] = useState<PaneId | "guide">("guide");
  const [intent, setIntent] = useState<SlashIntent>("ideas");
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [narrow, setNarrow] = useState(isNarrow);
  const [navOpen, setNavOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [palette, setPalette] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastMainRef = useRef<"workbench" | "case">("workbench");
  const [threadMotion] = useListMotion();
  const [sessionMotion] = useListMotion();

  useEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    const last = node.querySelector(".dsh-msg:last-of-type");
    last?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [current?.messages.length, busy]);

  useEffect(() => {
    const queue = state.knowledgeQueue ?? [];
    if (queue.length === 0) return;
    const incoming = queue.map((item, index) => ({
      id: `know-${Date.now().toString(36)}-${index}`,
      name: item.name,
      kind: item.kind,
      text: item.text,
      chars: item.text.length,
    }));
    dispatch({ type: "clear-knowledge-queue" });
    setPending((currentFiles) => {
      const seen = new Set(currentFiles.map((item) => `${item.name}:${item.chars}`));
      return [...currentFiles, ...incoming.filter((item) => !seen.has(`${item.name}:${item.chars}`))];
    });
    if (current && view === "case") {
      dispatch({ type: "attach-materials", caseId: current.id, materials: queue });
    }
  }, [current, dispatch, state.knowledgeQueue, view]);

  // Remember which conversation surface the user came from, so tool pages can send them back.
  useEffect(() => {
    if (view === "workbench" || view === "case") lastMainRef.current = view;
  }, [view]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
    } catch {
      // Storage can be unavailable in private windows; the preference then lasts for this session only.
    }
  }, [collapsed]);

  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    const sync = () => {
      setNarrow(media.matches);
      if (!media.matches) setNavOpen(false);
    };
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  // Ctrl/Cmd+B toggles the sidebar (the shadcn/ui Sidebar convention); Esc closes the mobile drawer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Never treat keys pressed while an IME is composing (pinyin, etc.) as shortcuts.
      if (event.isComposing || event.keyCode === 229) return;
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        if (narrow) setNavOpen((value) => !value);
        else setCollapsed((value) => !value);
        return;
      }
      // Ctrl/Cmd+K opens the command palette (the Linear / GitHub / VS Code convention).
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((value) => !value);
        return;
      }
      if (event.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow]);

  const focusComposer = useCallback(() => {
    // Wait one tick so a view switch has rendered the composer before focusing it.
    window.setTimeout(() => {
      const area = document.querySelector<HTMLTextAreaElement>(".dsh-compose textarea");
      if (!area) return;
      area.focus();
      const end = area.value.length;
      area.setSelectionRange(end, end);
    }, 40);
  }, []);

  const addFiles = async (files: File[]) => {
    for (const file of files) {
      const result = await readUserFile(file);
      if (!result.ok) {
        notify(result.reason);
        continue;
      }
      setPending((currentFiles) => {
        const rest = currentFiles.filter((item) => item.name !== result.file.name);
        return [...rest, result.file];
      });
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  };

  const newChat = () => {
    stop();
    setView("workbench");
    setText("");
    setPending([]);
    setIntent("ideas");
    setRightOpen(false);
    setNavOpen(false);
    focusComposer();
  };

  const submit = (forced?: { text: string; intent: SlashIntent; pursueTitle?: string }) => {
    const slash = parseSlash(forced?.text ?? text);
    // 没有附件、也没有材料的案子里，一句“帮我写一个××领域的发明专利”直接走一句话创作。
    const bareCase = !(current && view === "case") || (!(current.materials ?? []).length && !current.materialText.trim());
    const casualCreate = !forced && !slash.command && pending.length === 0 && bareCase && detectCreateRequest(slash.rest);
    // “不要问我，直接做”走全自动成稿：带附件时按附件成稿，只给领域时自动选题、出大纲再成稿。
    // 已有申请文件时，“修改你的图…给我全套文件”这类话是在改稿或要文件：优先走修改，不重新跑全自动成稿，也不进入闲聊。
    const hasDraft = Boolean(chatting && current?.inventionDraft?.text) && pending.length === 0;
    const draftAsk = !forced && !slash.command && hasDraft && (detectReviseRequest(slash.rest) || detectPackageRequest(slash.rest));
    const autoRequest = !forced && !slash.command && !draftAsk && detectAutoRequest(slash.rest);
    // 已有申请文件时，“把权利要求1放宽”“补充一个实施例”这类话直接修改稿件，而不是进入闲聊。
    const reviseRequest =
      draftAsk;
    const existing = current && view === "case" ? current : null;
    const hasMaterial =
      pending.length > 0 ||
      Boolean(existing && ((existing.materials ?? []).length || existing.materialText.trim())) ||
      dialogHasMaterial(existing?.messages, existing?.memory);
    // “总结 / 解读 / summarize / Section 4”是读材料：有附件或材料时走解读，按问题节选并标注页码，而不是进入挖点。
    const readRequest = !forced && !slash.command && !autoRequest && !reviseRequest && hasMaterial && detectReadRequest(slash.rest);
    const nextIntent = forced?.intent || (slash.command ? slash.intent : autoRequest ? "auto" : reviseRequest ? "revise" : readRequest ? "read" : casualCreate ? "create" : chatting ? "chat" : "ideas");
    const userText = slash.rest || defaultPrompt(nextIntent, hasMaterial);
    if (busy || (!forced && !slash.command && !slash.rest && pending.length === 0)) return;
    // 只打了「/」或半个技能命令（如「/发」）时不要当成对话发给模型：重新打开技能菜单让人选。
    // 不是任何命令前缀的斜杠文本（如路径 /usr/bin）照常发送。
    const bareSlashToken = !forced && pending.length === 0 && isIncompleteSlash(text);
    if (bareSlashToken) {
      setSlashHidden(false);
      notify("这是技能入口：从菜单选一个技能，或在命令后接着写内容再发送。");
      focusComposer();
      return;
    }
    setIntent(nextIntent);
    setText("");
    const attachments = pending.map((item) => ({ name: item.name, kind: item.kind, chars: item.chars, text: item.text }));
    setPending([]);
    setBusy(true);
    setRunSince(currentTime());
    const abort = new AbortController();
    abortRef.current = abort;
    const finish = (caseId: string, history = existing?.messages ?? [], materials = [...(existing?.materials ?? []), ...attachments], pursued = [
      ...(existing?.ideas ?? []).filter((idea) => idea.status === "pursued").map((idea) => idea.title),
      ...(forced?.pursueTitle ? [forced.pursueTitle] : []),
    ]) => {
      void runPatentTurn({
        caseId,
        materials: materials.map((item) => ({ name: item.name, kind: item.kind, text: item.text })),
        history,
        intent: nextIntent,
        pursued,
        ideas: existing?.ideas,
        facts: [...draftContext(existing).facts, ...(existing?.memory ?? []).map((note) => note.text)],
        chosenPoint: draftContext(existing).chosenPoint,
        draft: existing?.inventionDraft ?? null,
        userText,
        displayText: slash.rest || slash.command || "",
        recordUser: true,
        attachments: attachments.map((item) => ({ name: item.name, kind: item.kind, chars: item.chars, pages: pageCount(item.text) || undefined })),
        dispatch,
        signal: abort.signal,
      }).finally(() => {
        if (abortRef.current === abort) {
          abortRef.current = null;
          setBusy(false);
        }
      });
    };
    if (!existing) {
      const id = `case-${Date.now().toString(36)}`;
      dispatch({
        type: "create-case",
        id,
        title: (nextIntent === "create" || nextIntent === "auto") && createTopic(userText) ? `${createTopic(userText)}·发明专利创作` : titleFromMaterials(attachments, userText),
        text: "",
        fileName: attachments[0]?.name || "对话.md",
        skill: true,
        materials: attachments,
      });
      setView("case");
      finish(id, [], attachments, []);
      return;
    }
    if (attachments.length > 0) {
      dispatch({ type: "attach-materials", caseId: existing.id, materials: attachments });
    }
    finish(existing.id);
  };

  const pursue = (idea: PatentIdea) => {
    if (!current || busy) return;
    dispatch({ type: "idea-status", caseId: current.id, ideaId: idea.id, status: "pursued" });
    // 一句话创作出来的题目没有发明人自己的材料：选定后先设计大纲目录，而不是追问交底事实。
    const created = current.messages.some((message) => message.role === "trace" && message.text.startsWith(CREATE_TRACE_PREFIX));
    submit(
      created
        ? {
            text: `请以「${idea.title}」为题设计完整的大纲目录（技术方案、权利要求布局、附图清单、实施例安排），参数写建议值并标明待确认。`,
            intent: "outline",
            pursueTitle: idea.title,
          }
        : {
            text: `请以「${idea.title}」作为保护主题继续挖点，并预览交底提纲。缺的事实列成待确认，不要编造实验。`,
            intent: "disclosure",
            pursueTitle: idea.title,
          },
    );
  };

  // Slash menu: only while the user is still typing the command itself (no space yet).
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashHidden, setSlashHidden] = useState(false);
  const slashMatches = text.startsWith("/") && !/\s/.test(text) ? SLASH_SKILLS.filter((item) => item.command.includes(text) || text === "/") : [];
  const slashOpen = slashMatches.length > 0 && !slashHidden;
  const slashActive = Math.min(slashIndex, Math.max(slashMatches.length - 1, 0));
  const pickSlash = (item: (typeof SLASH_SKILLS)[number]) => {
    setText(`${item.command} `);
    setIntent(item.intent);
    setSlashIndex(0);
    focusComposer();
  };

  const showUtility = view !== "workbench" && view !== "case";
  const skillLabel = SLASH_SKILLS.find((item) => item.intent === intent)?.label || "挖点";
  const runKind = busy && current ? detectRunKind(intent, current.messages, runSince) : null;
  const runView = runKind && current ? runProgress(current.messages, { kind: runKind, since: runSince }) : null;
  const iconMode = collapsed && !narrow;

  const sessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? state.cases.filter((item) => item.title.toLowerCase().includes(needle)) : state.cases;
  }, [query, state.cases]);

  const conversationTarget = (): "workbench" | "case" => (lastMainRef.current === "case" && current ? "case" : "workbench");

  const go = (target: View) => {
    setRightOpen(false);
    setNavOpen(false);
    if (target === "knowledge") {
      const from = view === "case" || view === "workbench" ? (chatting ? "case" : "workbench") : conversationTarget();
      markKnowledgeBack(from);
    }
    setView(target);
  };

  const returnToChat = () => {
    setNavOpen(false);
    setView(conversationTarget());
    focusComposer();
  };

  // The skill menu lives in the composer, so leave tool pages first; otherwise the click changes nothing visible.
  const openSkills = () => {
    setNavOpen(false);
    setRightOpen(false);
    if (showUtility) setView(conversationTarget());
    setText("/");
    focusComposer();
  };

  const openCase = (id: string) => {
    dispatch({ type: "open-case", id });
    setNavOpen(false);
  };

  const topTitle = chatting && current ? current.title : showUtility ? VIEW_LABEL[view] ?? "工具" : "新对话";
  const sideClass = ["dsh-side", iconMode ? "collapsed" : "", navOpen ? "open" : ""].filter(Boolean).join(" ");

  const paletteCommands = (): PaletteCommand[] => {
    const commands: PaletteCommand[] = [];
    if (showUtility) commands.push({ id: "back", group: "page", label: "返回对话", hint: "页面", keywords: "back chat", run: returnToChat });
    commands.push(
      { id: "new", group: "action", label: "新对话", hint: "动作", keywords: "new chat 新建 开始", run: newChat },
      { id: "skills", group: "action", label: "调用内置技能", hint: "/", keywords: "skill slash 创作 一键成稿 挖点 交底书 大纲 发明稿 查新", run: openSkills },
      { id: "sidebar", group: "action", label: narrow ? "打开导航" : iconMode ? "展开侧边栏" : "收起侧边栏", hint: "Ctrl+B", keywords: "sidebar nav", run: () => (narrow ? setNavOpen(true) : setCollapsed((value) => !value)) },
      ...NAV.map((item) => ({ id: `view-${item.view}`, group: "page" as const, label: `打开${item.label}`, hint: "页面", keywords: item.view, run: () => go(item.view) })),
      { id: "view-settings", group: "page", label: "打开设置", hint: "页面", keywords: "settings model 模型 密钥 数据", run: () => go("settings") },
    );
    if (current) {
      const openPane = (target: PaneId | "guide") => {
        setNavOpen(false);
        if (view !== "case") dispatch({ type: "open-case", id: current.id });
        setRightOpen(true);
        setPane(target);
      };
      commands.push({ id: "pane-guide", group: "panel", label: "打开案件面板", detail: current.title, hint: "面板", keywords: "panel case 案件面板", run: () => openPane("guide") });
      for (const item of PANES) commands.push({ id: `pane-${item.id}`, group: "panel", label: item.title, hint: "面板", keywords: `panel 案件面板 ${item.hint}`, run: () => openPane(item.id) });
    }
    for (const item of state.cases) commands.push({ id: `session-${item.id}`, group: "session", label: item.title, hint: chatting && item.id === current?.id ? "当前会话" : "会话", current: Boolean(chatting && item.id === current?.id), keywords: "session 会话", run: () => openCase(item.id) });
    return commands;
  };

  return (
    <div className="dsh">
      <ClickRipple />
      {narrow && navOpen ? <button type="button" className="dsh-scrim" aria-label="关闭导航" onClick={() => setNavOpen(false)} /> : null}
      <aside className={sideClass} aria-label="主导航">
        <div className="dsh-side-head">
          <button type="button" className="dsh-brand" data-tip="PatentFlow 首页" aria-label="PatentFlow 首页（新对话）" onClick={newChat}>
            <img src="/brand-logo-256.png" alt="" />
            <span className="dsh-label">
              <b>PatentFlow</b>
              <small>专利挖掘工作台</small>
            </span>
          </button>
          <button
            type="button"
            className="dsh-icon-btn"
            aria-label={narrow ? "关闭导航" : iconMode ? "展开侧边栏" : "收起侧边栏"}
            aria-expanded={narrow ? navOpen : !iconMode}
            data-tip={iconMode ? "展开（Ctrl+B）" : "收起（Ctrl+B）"}
            title={narrow ? "关闭导航" : iconMode ? undefined : "收起侧边栏（Ctrl+B）"}
            onClick={() => (narrow ? setNavOpen(false) : setCollapsed((value) => !value))}
          >
            <Glyph name={narrow ? "close" : "sidebar"} />
          </button>
        </div>

        <button type="button" className={!chatting && !showUtility ? "dsh-new active" : "dsh-new"} data-tip="新对话" aria-label="新对话" onClick={newChat}>
          <Glyph name="plus" />
          <span className="dsh-label">新对话</span>
        </button>

        <nav className="dsh-nav" aria-label="工具">
          <p className="dsh-group">工具</p>
          {NAV.map((item) => {
            const active = view === item.view;
            return (
              <button
                key={item.view}
                type="button"
                className={active ? "dsh-item active" : "dsh-item"}
                aria-current={active ? "page" : undefined}
                data-tip={item.label}
                aria-label={item.label}
                onClick={() => go(item.view)}
              >
                <Glyph name={item.icon} />
                <span className="dsh-label">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <section className="dsh-recent" aria-label="会话">
          {iconMode ? (
            <button type="button" className="dsh-item" data-tip={`会话（${state.cases.length}）`} aria-label={`展开会话列表（${state.cases.length}）`} onClick={() => setCollapsed(false)}>
              <Glyph name="chat" />
            </button>
          ) : (
            <>
              <div className="dsh-recent-head">
                <p className="dsh-group">会话</p>
                <span>{state.cases.length}</span>
              </div>
              {state.cases.length > 4 ? (
                <label className="dsh-filter">
                  <Glyph name="search" />
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选会话" aria-label="筛选会话" />
                  {query ? (
                    <button type="button" className="dsh-filter-clear" aria-label="清除筛选" onClick={() => setQuery("")}>
                      <Glyph name="close" />
                    </button>
                  ) : null}
                </label>
              ) : null}
              <SessionList
                sessions={sessions}
                total={state.cases.length}
                activeId={view === "case" ? (current?.id ?? null) : null}
                busyId={busy ? (current?.id ?? null) : null}
                filtering={Boolean(query.trim())}
                listRef={sessionMotion}
                onOpen={openCase}
                onDeleted={(id) => {
                  if (current?.id === id) {
                    stop();
                    setRightOpen(false);
                    setView("workbench");
                  }
                }}
                onCleared={() => {
                  stop();
                  setRightOpen(false);
                  setView("workbench");
                }}
              />
              {sessions.length === 0 ? (
                <p className="dsh-side-empty">{query ? "没有匹配的会话。" : "还没有会话。发出第一条消息后会出现在这里。"}</p>
              ) : null}
            </>
          )}
        </section>

        <div className="dsh-side-foot">
          <button type="button" className="dsh-item" data-tip="内置技能" aria-label="内置技能" onClick={openSkills}>
            <Glyph name="skill" />
            <span className="dsh-label">内置技能</span>
          </button>
          <button
            type="button"
            className={view === "settings" ? "dsh-item active" : "dsh-item"}
            aria-current={view === "settings" ? "page" : undefined}
            data-tip="设置"
            aria-label="设置"
            onClick={() => go("settings")}
          >
            <Glyph name="settings" />
            <span className="dsh-label">设置</span>
          </button>
        </div>
      </aside>

      <div className="dsh-stage">
        <header className="dsh-top">
          <button type="button" className="dsh-icon-btn dsh-menu" aria-label="打开导航" onClick={() => setNavOpen(true)}>
            <Glyph name="menu" />
          </button>
          {showUtility ? <span className="dsh-top-kicker">工具 /</span> : null}
          <h2 className="dsh-top-title" title={topTitle}>{topTitle}</h2>
          {busy ? (
            <span className="dsh-status">
              <i className="dsh-live" />
              生成中
            </span>
          ) : null}
          <span className="dsh-top-spacer" />
          <a className="dsh-github" href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer" aria-label="GitHub 开源仓库（新标签页）" title="查看 GitHub 开源仓库">
            <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true"><path d={GITHUB_MARK_PATH} /></svg><span>GitHub</span><small>开源代码 ↗</small>
          </a>
          <button type="button" className="dsh-top-btn notice-trigger" onClick={() => setNoticeOpen(true)} aria-label="阅读免责声明与风险提示"><Glyph name="info" /><span>免责声明</span></button>
          <button type="button" className="dsh-top-btn dsh-kbar" aria-haspopup="dialog" aria-label="打开命令面板（Ctrl+K）" title="命令面板（Ctrl+K）" onClick={() => setPalette(true)}>
            <Glyph name="search" />
            <span>Ctrl K</span>
          </button>
          {showUtility ? (
            <button type="button" className="dsh-top-btn" title="返回对话" onClick={returnToChat}>
              <Glyph name="chat" />
              <span>返回对话</span>
            </button>
          ) : chatting ? (
            <button
              type="button"
              className={rightOpen ? "dsh-top-btn active" : "dsh-top-btn"}
              aria-pressed={rightOpen}
              title="案件面板"
              onClick={() => {
                setRightOpen((value) => !value);
                setPane("guide");
              }}
            >
              <Glyph name="panel" />
              <span>案件面板</span>
            </button>
          ) : null}
        </header>
        {noticeOpen ? <UsageNotice onClose={() => setNoticeOpen(false)} /> : null}

        <main className={chatting ? "dsh-main chatting" : "dsh-main"}>
          {showUtility ? (
            <div className="dsh-utility">
              {view === "search" ? <SearchPage /> : null}
              {view === "knowledge" ? <KnowledgePage /> : null}
              {view === "radar" ? <RadarPage /> : null}
              {view === "models" ? <ModelsPage /> : null}
              {view === "settings" ? <SettingsPage /> : null}
              {view === "primer" ? <PrimerPage /> : null}
            </div>
          ) : null}
          {!showUtility && !chatting ? (
            <div className="dsh-empty">
              <span className="dsh-eyebrow"><i aria-hidden="true" />AI 专利挖掘 · 参照 CNIPA 撰写格式</span>
              <div className="dsh-title">
                <img src="/brand-logo-256.png" alt="" />
                <h1>Patent<em>Flow</em></h1>
              </div>
              <p className="dsh-hello">把技术问题说出来，或把材料放进来，我们一起挖发明点。</p>
              <p className="dsh-meta">发明专利 · 当前技能 <b>{skillLabel}</b> · 输入 / 可切换</p>
              <div className="dsh-hints">
                {HINTS.map((item, index) => (
                  <button
                    key={item.command}
                    type="button"
                    onPointerMove={spotlight}
                    onClick={() => {
                      setText(item.text);
                      focusComposer();
                    }}
                  >
                    <i className="dsh-hint-no" aria-hidden="true">{String(index + 1).padStart(2, "0")}</i>
                    <b>
                      {item.title}
                      <code>{item.command}</code>
                    </b>
                    <span>{item.desc}</span>
                  </button>
                ))}
              </div>
              <ol className="dsh-flow" aria-label="一键生成流程">
                {FLOW.map((step, index) => (
                  <li key={step}><i>{index + 1}</i>{step}</li>
                ))}
              </ol>
            </div>
          ) : null}
          {chatting && current ? (
            <div className="dsh-thread" ref={threadRef}>
              <header>
                <h1>{current.title}</h1>
                <p>{SKILL_STEPS.join(" · ")}</p>
              </header>
              <ol ref={threadMotion}>
                {current.messages.map((message, index) => (
                  <li key={message.id} className={`dsh-msg ${message.role}`}>
                    {message.attachments?.length ? (
                      <ul className="msg-files">
                        {message.attachments.map((item) => (
                          <li key={`${message.id}-${item.name}`}>
                            <Glyph name="file" />
                            <span>{item.name}</span>
                            <small>{sizeLabel(item)}</small>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {message.role === "assistant" ? <ReplyBody text={message.text} /> : <p>{message.text}</p>}
                    <time>{formatTime(message.at)}</time>
                    {message.role === "user" && message.text.trim().length >= 4 ? (
                      <button
                        type="button"
                        className="msg-remember"
                        title="把这条内容加入案件记忆，之后每一轮都会参考"
                        onClick={() => {
                          dispatch({ type: "add-memory", caseId: current.id, text: message.text, source: "user" });
                          notify("已加入案件记忆。");
                        }}
                      >
                        记住
                      </button>
                    ) : null}
                    {message.role === "assistant" &&
                    !busy &&
                    message.text.startsWith(MODEL_FAIL_PREFIX) &&
                    index === lastIndexWhere(current.messages, (item) => item.role === "assistant") ? (
                      <div className="msg-actions" role="group" aria-label="模型失败后的恢复操作">
                        <button type="button" className="msg-action" onClick={() => go("models")}>
                          打开模型设置
                        </button>
                        {userTextBefore(current.messages, index) ? (
                          <button
                            type="button"
                            className="msg-action"
                            title="把上一句原话放回输入框，确认后再发送"
                            onClick={() => {
                              setText(userTextBefore(current.messages, index));
                              focusComposer();
                              notify("已把上一句放回输入框，确认后再发送。");
                            }}
                          >
                            放回输入框重发
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                ))}
                {busy && runView ? (
                  <li className="dsh-msg assistant run">
                    <RunProgressCard progress={runView} since={runSince} onStop={stop} />
                  </li>
                ) : busy ? (
                  <li className="dsh-msg assistant typing" aria-label="正在回复">
                    <i />
                    <i />
                    <i />
                  </li>
                ) : null}
              </ol>
              {current.inventionDraft?.text && !busy ? <PackageCard patentCase={current} busy={busy} onRevise={(instruction) => submit({ text: instruction, intent: "revise" })} /> : null}
              {(current.ideas ?? []).length > 0 ? (
                <section className="dsh-ideas">
                  <h2>{current.messages.some((message) => message.role === "trace" && message.text.startsWith(CREATE_TRACE_PREFIX)) ? "候选发明题目" : "候选发明点"}</h2>
                  {current.ideas.map((idea) => (
                    <article key={idea.id} className={idea.status}>
                      <b>{idea.title}</b>
                      {idea.problem ? <p>问题：{idea.problem}</p> : null}
                      {idea.feature ? <p>特征：{idea.feature}</p> : null}
                      {idea.effect ? <p>效果：{idea.effect}</p> : null}
                      {idea.pending ? <p>待确认：{idea.pending}</p> : null}
                      {idea.status === "open" ? (
                        <div className="idea-actions">
                          <button type="button" disabled={busy} title={busy ? "等当前回复结束后再推进" : undefined} onClick={() => pursue(idea)}>
                            {current.messages.some((message) => message.role === "trace" && message.text.startsWith(CREATE_TRACE_PREFIX)) ? "选这个题目" : "按这个挖"}
                          </button>
                          <button type="button" onClick={() => dispatch({ type: "idea-status", caseId: current.id, ideaId: idea.id, status: "dismissed" })}>
                            先不算
                          </button>
                        </div>
                      ) : (
                        <small>{idea.status === "pursued" ? "正在推进" : "已放下"}</small>
                      )}
                    </article>
                  ))}
                  {!busy && !current.inventionDraft?.text && current.ideas.some((idea) => idea.status === "open") && !current.ideas.some((idea) => idea.status === "pursued") ? (
                    <div className="idea-actions dsh-auto-next">
                      <button type="button" onClick={() => submit({ text: "按照你的想法来进行，不要询问我，直接帮我做", intent: "auto" })}>
                        不想选？按推荐题目一键成稿
                      </button>
                    </div>
                  ) : null}
                </section>
              ) : null}
              {!busy && !current.inventionDraft?.text && (current.materials ?? []).some((item) => item.name === OUTLINE_MATERIAL_NAME) ? (
                <section className="dsh-ideas dsh-outline-next">
                  <h2>大纲已就绪</h2>
                  <article>
                    <p>大纲里的参数是建议值、效果是预期。想改哪里直接在下面说，我会按你的修改更新；确认后一键生成权利要求书、说明书、摘要和附图说明，可下载 DOCX。</p>
                    <div className="idea-actions">
                      <button
                        type="button"
                        onClick={() =>
                          submit({
                            text: "按创作大纲写完整的发明专利申请文件：权利要求书、说明书（技术领域、背景技术、发明内容、附图说明、具体实施方式）和摘要。",
                            intent: "draft",
                          })
                        }
                      >
                        按大纲写完整稿
                      </button>
                    </div>
                  </article>
                </section>
              ) : null}
              {current.facts.length > 0 ? (
                <section>
                  <h2>技术事实</h2>
                  {current.facts.map((fact) => (
                    <article key={fact.id}>
                      <KindMark kind={fact.kind} />
                      <span>{fact.origin === "inference" ? "推断" : fact.status === "confirmed" ? "已确认" : "待确认"}</span>
                      <p>{fact.statement}</p>
                      {fact.status !== "confirmed" ? (
                        <button type="button" onClick={() => dispatch({ type: "fact-status", caseId: current.id, factId: fact.id, status: "confirmed" })}>
                          {fact.origin === "inference" ? "知悉，不写入" : "确认"}
                        </button>
                      ) : fact.origin === "inference" ? (
                        <small className="fact-ack">已记录知悉</small>
                      ) : null}
                    </article>
                  ))}
                </section>
              ) : null}
            </div>
          ) : null}
          {!showUtility ? (
            <div
              className="dsh-compose"
              onKeyDownCapture={(event) => {
                if (!slashOpen || event.nativeEvent.isComposing) return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  event.stopPropagation();
                  const delta = event.key === "ArrowDown" ? 1 : -1;
                  setSlashIndex((slashActive + delta + slashMatches.length) % slashMatches.length);
                } else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
                  event.preventDefault();
                  event.stopPropagation();
                  pickSlash(slashMatches[slashActive]);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setSlashHidden(true);
                }
              }}
            >
              <AnimatePresence>
                {slashOpen ? (
                  <motion.div
                    className="dsh-slash"
                    role="listbox"
                    aria-label="内置技能"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 6 }}
                    transition={{ duration: 0.18 }}
                  >
                    {slashMatches.map((item, index) => (
                      <button
                        key={item.command}
                        role="option"
                        aria-selected={index === slashActive}
                        className={index === slashActive ? "active" : undefined}
                        onMouseEnter={() => setSlashIndex(index)}
                        type="button"
                        onClick={() => {
                          setText(`${item.command} `);
                          setIntent(item.intent);
                          focusComposer();
                        }}
                      >
                        <b>{item.command}</b>
                        <span>{item.hint}</span>
                      </button>
                    ))}
                  </motion.div>
                ) : null}
              </AnimatePresence>
              <Composer
                appearance="harness"
                value={text}
                placeholder={chatting ? "继续追问、补充条件，或再拖入资料" : "描述技术方案或问题，也可以拖入 PDF、Word、PPT、图片等资料"}
                busy={busy}
                attachments={pending}
                onChange={(value) => {
                  setText(value);
                  setSlashHidden(false);
                  setSlashIndex(0);
                }}
                onSubmit={() => submit()}
                onPickFile={(file) => void addFiles([file])}
                onRemoveAttachment={(id) => setPending((items) => items.filter((item) => item.id !== id))}
                onStop={stop}
                onOpenKnowledge={() => {
                  markKnowledgeBack(chatting ? "case" : "workbench");
                  setView("knowledge");
                }}
              />
              <p className="dsh-foot">{pending.length ? "附件会作为案件材料保存，不会塞进输入框。" : <>Enter 发送 · Shift+Enter 换行 · 输入 / 调用技能<span className="dsh-foot-desk"> · Ctrl+K 更多操作</span></>}</p>
            </div>
          ) : null}
        </main>
      </div>

      {rightOpen ? (
        <aside className="dsh-right" aria-label="案件面板">
          <header>
            <span>
              <Glyph name={pane === "guide" ? "panel" : PANES.find((item) => item.id === pane)?.icon ?? "doc"} />
              {pane === "guide" ? "案件面板" : PANES.find((item) => item.id === pane)?.title}
            </span>
            <button type="button" onClick={() => setRightOpen(false)} aria-label="关闭右侧栏">
              <Glyph name="close" />
            </button>
          </header>
          {pane === "guide" ? (
            <div className="dsh-guide">
              {!current ? (
                <div className="dsh-guide-empty">
                  <b>还没有打开的案件</b>
                  <small>发出第一条消息后，材料、交底书、权利要求都会出现在这里。</small>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => {
                      setRightOpen(false);
                      focusComposer();
                    }}
                  >
                    去输入框开始
                  </button>
                </div>
              ) : null}
              {PANES.map((item) => (
                <button key={item.id} type="button" disabled={!current} onClick={() => setPane(item.id)}>
                  <i>
                    <Glyph name={item.icon} />
                  </i>
                  <span>
                    <b>{item.title}</b>
                    <small>{item.hint}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="dsh-pane">
              <button type="button" className="text-btn" onClick={() => setPane("guide")}>
                返回
              </button>
              {current && pane === "draft" ? <DisclosureView text={current.disclosure} /> : null}
              {current && pane === "draft" && current.disclosure ? (
                <button type="button" className="btn ghost" onClick={() => {
                  downloadDisclosure(current)
                    .then((report) => notify(report ? `已下载申请文件格式 DOCX。${reportSummary(report)}` : "已下载 DOCX 草稿"))
                    .catch((error: unknown) => notify(error instanceof Error ? error.message : "导出失败"));
                }}>
                  导出 DOCX
                </button>
              ) : null}
              {current && pane === "material" ? (
                (current.materials ?? []).length ? (
                  current.materials.map((item) => (
                    <article key={item.id} className="material-card">
                      <b>{item.name}</b>
                      <small>{sizeLabel(item)}</small>
                      <pre>{item.text}</pre>
                    </article>
                  ))
                ) : (
                  <pre>还没有资料。把文件拖到输入框即可（支持 PDF、Word、PPT、Excel、图片等）。</pre>
                )
              ) : null}
              {current?.inventionDraft?.text && ['claims','chart','figures','review','diff'].includes(pane) ? <Suspense fallback={<p>正在读取当前申请稿…</p>}><DraftDetailPanel draft={current.inventionDraft} title={current.title} pane={pane}/></Suspense> : null}
              {current && !current.inventionDraft?.text && pane === "claims" ? (current.claims.length ? current.claims.map((claim) => <p key={claim.id}>{claim.no}. {claim.text}</p>) : <p className="empty-copy">还没有权利要求。</p>) : null}
              {current && !current.inventionDraft?.text && pane === "chart" ? <ClaimChart patentCase={current} /> : null}
              {current && pane === "files" ? (current.inventionDraft?.text ? <Suspense fallback={<p className="empty-copy">正在载入申请文件…</p>}><PackageCard patentCase={current} compact busy={busy} onRevise={(instruction) => submit({ text: instruction, intent: "revise" })} /></Suspense> : <p className="empty-copy">还没有申请文件。在输入框发送 /发明稿，一句话或一份资料就能生成全套文件。</p>) : null}
              {current && pane === "memory" ? <MemoryPanel patentCase={current} /> : null}
              {current && !current.inventionDraft?.text && pane === "figures" ? (current.figures.length ? current.figures.map((figure) => <p key={figure.id}>图{figure.no} {figure.label}</p>) : <p className="empty-copy">还没有附图。</p>) : null}
              {current && !current.inventionDraft?.text && pane === "review" ? (current.issues.length ? current.issues.map((issue) => <p key={issue.id}>{issue.title}：{issue.detail}</p>) : <p className="empty-copy">自检没有留下问题。</p>) : null}
              {current && !current.inventionDraft?.text && pane === "diff" ? <p>{current.versions.length < 2 ? "接受一次修改后会出现差异。" : current.versions.map((version) => version.label).join(" → ")}</p> : null}
              {!current ? <p>先开始一条对话。</p> : null}
            </div>
          )}
        </aside>
      ) : null}
      {palette ? <CommandPalette commands={paletteCommands()} onClose={() => setPalette(false)} /> : null}
      {toast ? <div className="dsh-toast" role="status">{toast}</div> : null}
    </div>
  );
}
