import { useEffect, useState } from "react";
import { useListMotion } from "./fx.tsx";
import { LEGAL_NOTES, PUBLICATIONS, STAGE_LABEL, activeCase, searchPublications } from "./model.ts";
import type { PatentCase, SearchScope } from "./model.ts";
import { activateProvider, getAccessPolicy, importCcSwitch, listCcSwitch, listProviders, removeProvider, searchAny, testProvider } from "./provider-api.ts";
import type { CcLocalProvider } from "./provider-api.ts";
import type { PublicProvider } from "./provider-api.ts";
import { ImportPanel } from "./import-panel.tsx";
import { LibraryPanel } from "./library-panel.tsx";
import { CcSwitchShelf } from "./model-menu.tsx";
import { PersonalModelsPanel } from './personal-models-panel.tsx';
import { patentWebQuery, patentPageLeads } from './patent-search-scope.ts';
import { VendorMark } from "./vendor-mark.tsx";
import { readUserFile, UPLOAD_ACCEPT, UPLOAD_HINT } from "./read-user-file.ts";
import { useStore } from "./store.tsx";
import { markKnowledgeBack, takeKnowledgeBack } from "./ui-nav.ts";
import { ClaimChart, formatTime } from "./widgets.tsx";
import { sizeLabel } from "./page-count.ts";

export function CasesPage() {
  const { state, dispatch } = useStore();
  const [stage, setStage] = useState("all");
  const cases = state.cases.filter((patentCase) => stage === "all" || patentCase.stage === stage);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="kicker">案件</p>
          <h1>我的专利</h1>
        </div>
        <button className="btn primary" type="button" onClick={() => dispatch({ type: "navigate", view: "workbench" })}>
          新建案件
        </button>
      </header>
      <div className="filters">
        <button type="button" className={stage === "all" ? "chip active" : "chip"} onClick={() => setStage("all")}>全部</button>
        {Object.entries(STAGE_LABEL).map(([id, label]) => (
          <button key={id} type="button" className={stage === id ? "chip active" : "chip"} onClick={() => setStage(id)}>{label}</button>
        ))}
      </div>
      <div className="case-table">
        {cases.length === 0 ? <p className="empty-copy">这个状态下没有案件。</p> : null}
        {cases.map((patentCase) => (
          <article key={patentCase.id}>
            <div>
              <h2>{patentCase.title}</h2>
              <p>
                {patentCase.patentType} · {STAGE_LABEL[patentCase.stage]} · {formatTime(patentCase.createdAt)}
                {patentCase.demo ? " · 示范" : ""}
              </p>
            </div>
            <div className="row-actions">
              <button className="btn ghost" type="button" onClick={() => dispatch({ type: "open-case", id: patentCase.id })}>打开</button>
              <button className="text-btn" type="button" onClick={() => dispatch({ type: "delete-case", id: patentCase.id })}>删除</button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

export function KnowledgePage() {
  const { state, dispatch, setView, notify } = useStore();
  const [bucket, setBucket] = useState<"mine" | "private" | "demo" | "law" | "library">("mine");
  const [picked, setPicked] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [uploadResult, setUploadResult] = useState("");
  const selected = PUBLICATIONS.find((item) => item.id === state.selectedPubId) ?? PUBLICATIONS[0];
  const privateCase = state.cases.find((item) => item.id === state.activeCaseId) ?? state.cases[0];
  const mine = state.knowledge ?? [];
  const selectedMine = mine.find((item) => picked.includes(item.id)) ?? mine[0];
  const [listMotion] = useListMotion();

  const toggle = (id: string) => {
    setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const loadIntoChat = (ids: string[]) => {
    const usable = ids.filter(Boolean);
    if (usable.length === 0) {
      notify("先勾选要载入的材料。");
      return;
    }
    dispatch({ type: "queue-knowledge", ids: usable });
    setView(takeKnowledgeBack() === "case" && state.activeCaseId ? "case" : "workbench");
    notify(`已把 ${usable.length} 份知识库材料放入对话。`);
  };

  const nav = (
    <aside>
      <h1 className="sr-only">专利知识库</h1>
      <p className="nav-label">库</p>
      <button type="button" className={bucket === "mine" ? "nav-btn active" : "nav-btn"} onClick={() => setBucket("mine")}>我上传的</button>
      <button type="button" className={bucket === "private" ? "nav-btn active" : "nav-btn"} onClick={() => setBucket("private")}>案件材料</button>
      <button type="button" className={bucket === "demo" ? "nav-btn active" : "nav-btn"} onClick={() => setBucket("demo")}>示范公开文献</button>
      <button type="button" className={bucket === "law" ? "nav-btn active" : "nav-btn"} onClick={() => setBucket("law")}>法规要点</button>
      <button type="button" className={bucket === "library" ? "nav-btn active" : "nav-btn"} onClick={() => setBucket("library")}>专利分类与样例</button>
    </aside>
  );

  if (bucket === "library") {
    return (
      <div className="knowledge">
        {nav}
        <LibraryPanel onLoad={loadIntoChat} notify={notify} />
      </div>
    );
  }

  return (
    <div className="knowledge">
      {nav}
      <section ref={listMotion}>
        {bucket === "mine" ? (
          <>
            <label className="btn primary file-btn knowledge-upload">
              {importing ? "正在读取材料…" : "上传到知识库"}
              <input
                type="file"
                multiple
                accept={UPLOAD_ACCEPT}
                aria-label="上传到知识库"
                disabled={importing}
                onChange={(event) => {
                  const files = event.target.files;
                  if (!files) return;
                  setImporting(true);
                  setUploadResult("");
                  void Promise.all(Array.from(files).map((file) => readUserFile(file))).then((results) => {
                    const errors: string[] = [];
                    let imported = 0;
                    results.forEach((result) => {
                      if (!result.ok) {
                        errors.push(result.reason);
                        return;
                      }
                      imported += 1;
                      dispatch({ type: "add-knowledge", name: result.file.name, kind: result.file.kind, text: result.file.text });
                    });
                    const summary = `已加入 ${imported} 份材料。${errors.join("；")}`;
                    setUploadResult(summary);
                    notify(summary);
                  }).catch(() => setUploadResult("读取未完成，请重试；已有知识库材料没有改动。")).finally(() => setImporting(false));
                  event.target.value = "";
                }}
              />
            </label>
            {uploadResult ? <p className="fine" role="status">{uploadResult}</p> : null}
            {mine.length === 0 ? <p className="empty-copy">还没有上传材料。支持{UPLOAD_HINT}，可保存在这里再载入对话。</p> : null}
            {mine.map((item) => (
              <label key={item.id} className={picked.includes(item.id) ? "result selected check-result" : "result check-result"}>
                <input type="checkbox" checked={picked.includes(item.id)} onChange={() => toggle(item.id)} />
                <span>
                  <strong>{item.name}</strong>
                  <small>{sizeLabel(item)} · {formatTime(item.at)}</small>
                </span>
              </label>
            ))}
          </>
        ) : null}
        {bucket === "demo"
          ? PUBLICATIONS.map((publication) => (
              <button key={publication.id} type="button" className={publication.id === selected.id ? "result selected" : "result"} onClick={() => dispatch({ type: "select-pub", id: publication.id })}>
                <strong>{publication.title}</strong>
                <span>{publication.number} · {publication.publicationDate}</span>
              </button>
            ))
          : null}
        {bucket === "private"
          ? state.cases.map((patentCase) => (
              <button key={patentCase.id} type="button" className="result" onClick={() => dispatch({ type: "open-case", id: patentCase.id })}>
                <strong>{patentCase.title}</strong>
                <span>私有材料 · {patentCase.materialName}</span>
              </button>
            ))
          : null}
        {bucket === "law"
          ? LEGAL_NOTES.map((note) => (
              <article key={note.id} className="result selected">
                <strong>{note.title}</strong>
                <span>{note.citation}</span>
              </article>
            ))
          : null}
      </section>
      <article className="detail">
        {bucket === "mine" ? (
          selectedMine ? (
            <div>
              <p className="mark mark-severe">私有 · 默认不外发</p>
              <h1>{selectedMine.name}</h1>
              <p className="fine">{selectedMine.chars} 字</p>
              <div className="composer-bar">
                <button className="btn primary" type="button" onClick={() => loadIntoChat(picked.length ? picked : [selectedMine.id])}>加入当前对话</button>
                <button className="text-btn" type="button" onClick={() => dispatch({ type: "remove-knowledge", id: selectedMine.id })}>移出知识库</button>
              </div>
              <pre className="knowledge-text">{selectedMine.text}</pre>
            </div>
          ) : (
            <p className="empty-copy">上传论文、实验记录或公开文本，再点“加入当前对话”，会作为附件进入输入框。</p>
          )
        ) : null}
        {bucket === "demo" ? (
          <div>
            <PublicationDetail publication={selected} />
            <button className="btn primary" type="button" onClick={() => loadIntoChat([selected.id])}>把这篇示范文献加入对话</button>
          </div>
        ) : null}
        {bucket === "private" && privateCase ? <PrivateDetail patentCase={privateCase} /> : null}
        {bucket === "law" ? (
          <div>
            <p className="mark mark-confirm">{LEGAL_NOTES[0].effective}</p>
            <h1>{LEGAL_NOTES[0].title}</h1>
            <p>{LEGAL_NOTES[0].point}</p>
            <a href={LEGAL_NOTES[0].sourceUrl} target="_blank" rel="noreferrer">查看官方文本</a>
            <div className="composer-bar">
              <button className="btn primary" type="button" onClick={() => loadIntoChat([LEGAL_NOTES[0].id])}>把这条法规加入对话</button>
            </div>
          </div>
        ) : null}
      </article>
    </div>
  );
}

function PublicationDetail({ publication }: { publication: (typeof PUBLICATIONS)[number] }) {
  return (
    <div>
      <p className="demo-banner">虚构示范文本，不是官方专利文献。状态 {publication.status} 只表示这份内置文本可定位。</p>
      <h1>{publication.title}</h1>
      <dl className="meta">
        <div><dt>文献号</dt><dd>{publication.number}</dd></div>
        <div><dt>日期</dt><dd>{publication.publicationDate}</dd></div>
        <div><dt>申请人</dt><dd>{publication.assignee}</dd></div>
        <div><dt>分类号</dt><dd>{publication.ipcNote}</dd></div>
      </dl>
      <h2>正文</h2>
      <p>{publication.text}</p>
      <h2>权利要求</h2>
      <p>{publication.claimsText}</p>
    </div>
  );
}

function PrivateDetail({ patentCase }: { patentCase: PatentCase }) {
  return (
    <div>
      <p className="mark mark-severe">私有 · 默认不外发</p>
      <h1>{patentCase.title}</h1>
      <p>{patentCase.materialText}</p>
    </div>
  );
}

export { RadarPage } from "./radar-page.tsx";

export function SearchPage() {
  const { state, dispatch } = useStore();
  const [draft, setDraft] = useState(state.searchQuery);
  const [askWeb, setAskWeb] = useState(true);
  const [webDetail, setWebDetail] = useState("");
  const [webResults, setWebResults] = useState<Array<{ title: string; url: string; snippet: string }>>([]);
  const results = searchPublications(state.searchQuery, state.searchScope);
  const current = activeCase(state);
  const showLaw = /第三十三|修改超出|原始记载/.test(state.searchQuery);
  const [resultMotion] = useListMotion();
  const [webMotion] = useListMotion();
  return (
    <div className="page">
      <p className="kicker">检索</p>
      <h1>专利检索</h1>
      <form
        className="search-row"
        onSubmit={(event) => {
          event.preventDefault();
          const query = draft.trim();
          dispatch({ type: "search", query, scope: state.searchScope });
          if (!query) {
            setWebResults([]);
            setWebDetail(askWeb && state.searchScope !== "private" ? "检索式为空：已显示示范库全部文献；输入关键词或公开号后才会发给 AnySearch。" : "");
            event.currentTarget.querySelector("input")?.focus();
            return;
          }
          if (!askWeb || state.searchScope === "private") {
            setWebResults([]);
            setWebDetail(state.searchScope === "private" ? "私有材料不会发给 AnySearch。" : "");
            return;
          }
          setWebDetail("正在向 AnySearch 发送检索式。");
          const webQuery = patentWebQuery(query);
          void searchAny(webQuery.query, 'cn').then((found) => {
            const leads = patentPageLeads(found.results, webQuery.scoped);
            setWebResults(leads);
            setWebDetail(!found.ok || !webQuery.scoped ? found.detail : leads.length
              ? leads.length + ' 条专利页面线索，已排除非专利页面；内容与相关性仍需核验。'
              : '没有获得可用的专利页面线索，请调整关键词。这不表示不存在相关专利。');
          });
        }}
      >
        <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="检索示范文献的标题、正文或编号" aria-label="检索式" />
        <button className="btn primary" type="submit">检索</button>
      </form>
      <div className="filters">
        {([["all", "全部范围"], ["demo", "示范公开文献"], ["private", "只看私有材料"]] as Array<[SearchScope, string]>).map(([id, label]) => (
          <button key={id} type="button" className={state.searchScope === id ? "chip active" : "chip"} onClick={() => dispatch({ type: "search", query: state.searchQuery, scope: id })}>
            {label}
          </button>
        ))}
      </div>
      {state.searchScope !== "private" ? (
        <div className="result-list" ref={resultMotion}>
          {results.length === 0 ? <p className="empty-copy">示范库里没有匹配文献。这不表示公开专利中不存在相关技术。</p> : null}
          {results.map((publication) => (
            <article key={publication.id} className="result-card">
              <div>
                <h2>{publication.title}</h2>
                <p>{publication.number} · {publication.publicationDate} · {publication.assignee}</p>
                <p>{publication.text}</p>
              </div>
              <div className="row-actions">
                <button className="btn ghost" type="button" disabled={!current} title={!current ? "先打开或新建一个案件，再标记 D1/D2" : undefined} aria-pressed={current?.priorArt.d1 === publication.id} onClick={() => current && dispatch({ type: "pin-art", caseId: current.id, pubId: publication.id, slot: "d1" })}>
                  {current?.priorArt.d1 === publication.id ? "已是 D1" : "标为 D1"}
                </button>
                <button className="btn ghost" type="button" disabled={!current} title={!current ? "先打开或新建一个案件，再标记 D1/D2" : undefined} aria-pressed={current?.priorArt.d2 === publication.id} onClick={() => current && dispatch({ type: "pin-art", caseId: current.id, pubId: publication.id, slot: "d2" })}>
                  {current?.priorArt.d2 === publication.id ? "已是 D2" : "标为 D2"}
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="result-list" ref={resultMotion}>
          {state.cases.filter((patentCase) => !state.searchQuery || `${patentCase.title}${patentCase.materialText}`.includes(state.searchQuery)).map((patentCase) => (
            <article key={patentCase.id} className="result-card">
              <div>
                <h2>{patentCase.title}</h2>
                <p>私有材料不会进入外部检索。</p>
              </div>
              <button className="btn ghost" type="button" onClick={() => dispatch({ type: "open-case", id: patentCase.id })}>打开</button>
            </article>
          ))}
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={askWeb} onChange={(event) => setAskWeb(event.target.checked)} />
        同时把检索式发给 AnySearch。不会附带案件正文。
      </label>
      <p className="fine">默认限定 Google Patents 专利页面；可在检索式中用 site: 指定其他来源。网页线索不等于官方查新结论。</p>
      {webDetail ? <p className="fine" role="status">{webDetail}</p> : null}
      {webResults.length > 0 ? (
        <div className="result-list" ref={webMotion}>
          {webResults.map((item) => (
            <article key={item.url || item.title} className="result-card">
              <div>
                <span className="mark mark-confirm">AnySearch 线索 · 未核验</span>
                <h2>{item.title}</h2>
                <p>{item.snippet}</p>
                {item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.url}</a> : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {!current ? <p className="fine">先打开一个案件，才能把文献标成对比文件。</p> : <p className="fine">对比文件将写入：{current.title}</p>}
      {showLaw ? (
        <article className="panel">
          <h2>{LEGAL_NOTES[0].citation}</h2>
          <p>{LEGAL_NOTES[0].point}</p>
        </article>
      ) : null}
    </div>
  );
}

export function AnalysisPage() {
  const { state, dispatch } = useStore();
  const current = activeCase(state);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="kicker">分析</p>
          <h1>技术分析</h1>
        </div>
        <label>
          案件
          <select value={current?.id ?? ""} onChange={(event) => dispatch({ type: "focus-case", id: event.target.value })}>
            {state.cases.map((patentCase) => (
              <option key={patentCase.id} value={patentCase.id}>{patentCase.title}</option>
            ))}
          </select>
        </label>
      </header>
      {!current || current.claims.length === 0 ? (
        <p className="empty-copy">这件还没有权利要求。先确认事实并生成草稿，树和对照表才会出现。</p>
      ) : (
        <div className="analysis-grid">
          <section>
            <h2>权利要求树</h2>
            <ol className="tree">
              {current.claims.filter((claim) => claim.parentNo === null).map((claim) => (
                <li key={claim.id}>
                  <strong>权利要求 {claim.no}</strong>
                  <p>{claim.text}</p>
                  <ol>
                    {current.claims.filter((child) => child.parentNo === claim.no).map((child) => (
                      <li key={child.id}>
                        <strong>权利要求 {child.no}</strong>
                        <p>{child.text}</p>
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ol>
          </section>
          <section>
            <h2>特征对照</h2>
            <ClaimChart patentCase={current} />
          </section>
        </div>
      )}
    </div>
  );
}

export function SkillsPage() {
  const { state, dispatch } = useStore();
  return (
    <div className="page">
      <p className="kicker">能力</p>
      <h1>Skills</h1>
      <p className="lede">这些开关记录你准备使用的领域流程。抓取脚本保持关闭。浏览器里没有执行上游专利技能的 Python 工具。</p>
      <div className="skill-grid">
        {state.skills.map((skill) => (
          <article key={skill.id} className="panel">
            <header className="panel-head">
              <h2>{skill.name}</h2>
              <button className="text-btn" type="button" disabled={Boolean(skill.lockedReason)} onClick={() => dispatch({ type: "toggle-skill", id: skill.id })}>
                {skill.lockedReason ? "已锁定" : skill.enabled ? "已启用" : "已停用"}
              </button>
            </header>
            <p>{skill.summary}</p>
            {skill.lockedReason ? <p className="fine">{skill.lockedReason}</p> : null}
          </article>
        ))}
      </div>
    </div>
  );
}

export function ModelsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { notify } = useStore();
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [local, setLocal] = useState<CcLocalProvider[]>([]);
  const [localDetail, setLocalDetail] = useState("正在读取 CC Switch 配置。");
  const [busy, setBusy] = useState("");
  const [ready, setReady] = useState(false);
  const managedOnly = providers.some((item) => item.managed);

  const reload = async () => {
    setProviders(await listProviders());
    setReady(true);
  };

  const loadLocal = () => {
    void listCcSwitch().then((found) => {
      setLocal(found.providers);
      setLocalDetail(found.detail);
    }).catch(() => setLocalDetail("没有读到 CC Switch 配置。"));
  };

  useEffect(() => {
    if (!ready || managedOnly) return;
    const timer = window.setTimeout(loadLocal, 0);
    return () => window.clearTimeout(timer);
  }, [ready, managedOnly]);

  useEffect(() => {
    let cancelled = false;
    void listProviders().then((items) => {
      if (!cancelled) {
        setProviders(items);
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const openai = providers.filter((item) => item.role === "model" && item.protocol === "openai" && !item.personal);
  const claude = providers.filter((item) => item.role === "model" && item.protocol === "claude" && !item.personal);
  const search = providers.filter((item) => item.role === "search");

  return (
    <div className={embedded ? "models-embed" : "page page-narrow"}>
      {embedded ? <h2>已配置的模型</h2> : (
        <>
          <p className="kicker">模型</p>
          <h1>模型与工具</h1>
          <p className="lede">{managedOnly ? "站点默认服务由管理员维护；你也可以配置自己的模型和 API Key。个人配置不会影响其他用户。" : "提供方按 OpenAI 协议和 Claude 协议分开。密钥只保存在服务端，页面只显示末四位。"}</p>
        </>
      )}
      {ready && !managedOnly ? <CcSwitchShelf
        local={local}
        detail={localDetail}
        busy={busy}
        onRefresh={loadLocal}
        onUse={(item, model) => {
          if (!item.canImport) {
            notify(item.reason || "这个提供方还不能导入。");
            return;
          }
          setBusy(item.key + model);
          void importCcSwitch(item.key, model).then((result) => {
            setBusy("");
            if (result.error) {
              notify(result.error);
              return;
            }
            notify(`已切换到 ${item.name}${model ? ` · ${model}` : ""}。`);
            void reload();
          });
        }}
      /> : null}
      {getAccessPolicy()?.mode === 'public' ? <p className="public-quota-note">公开体验 · 无需邀请码。全站每日共享模型 {getAccessPolicy()?.dailySharedModelCalls} 次、检索 {getAccessPolicy()?.dailySharedSearchCalls} 次上游调用，北京时间零点重置。一键生成会调用多次；个人模型 Key 不占共享模型额度。</p> : null}
      {managedOnly ? <PersonalModelsPanel onChanged={() => void reload()} /> : null}
      {ready ? (
        <>
          <ProviderGroup title="OpenAI 协议" items={openai} busy={busy} setBusy={setBusy} reload={reload} notify={notify} />
          <ProviderGroup title="Claude 协议" items={claude} busy={busy} setBusy={setBusy} reload={reload} notify={notify} />
          <ProviderGroup title="检索" items={search} busy={busy} setBusy={setBusy} reload={reload} notify={notify} />
        </>
      ) : (
        <p className="fine">正在读取已配置的模型。</p>
      )}
      {ready && !managedOnly ? <ImportPanel onImported={() => void reload()} /> : null}
    </div>
  );
}

function ProviderGroup({ title, items, busy, setBusy, reload, notify }: { title: string; items: PublicProvider[]; busy: string; setBusy: (value: string) => void; reload: () => Promise<void>; notify: (message: string) => void }) {
  if (items.length === 0) return <article className="panel"><h2>{title}</h2><p className="fine">还没有这一类提供方。</p></article>;
  return (
    <section className="provider-group">
      <h2>{title}</h2>
      {items.map((item) => (
        <article key={item.id} className="panel">
          <header className="panel-head">
            <h2 className="provider-title"><VendorMark icon={item.icon} name={item.name} model={item.model} website={item.website} color={item.iconColor} />{item.name}</h2>
            <span className={item.hasKey && item.available !== false ? "judge judge-明确包含" : "judge judge-待确认"}>{item.available === false ? '暂不可用' : item.managed ? item.hasKey ? "管理员已配置" : "待管理员配置" : item.hasKey ? "密钥已就位" : "缺少密钥"}</span>
          </header>
          <p>{item.role === "search" ? "检索工具" : item.protocol === "openai" ? "OpenAI 协议" : "Claude 协议"}{item.active ? " · 当前模型" : ""}</p>
          <p className="fine">{item.managed ? "由管理员统一配置（只读）" : `${item.website || "未填网站"} · ${item.baseUrl || "未填接口"}`}{item.model ? ` · ${item.model}` : ""}</p>
          {item.availabilityDetail ? <p className="model-availability">{item.availabilityDetail}{item.checkedAt ? ' 核验时间：' + formatTime(item.checkedAt) : ''}</p> : null}
          {item.managed && item.role === 'model' ? <div className="composer-bar">
            <button type="button" className="btn ghost" disabled={busy !== '' || item.active || item.available === false || !item.hasKey} onClick={() => { setBusy('activate-' + item.id); void activateProvider(item.id).then(reload).catch(() => notify('切换未完成。')).finally(() => setBusy('')); }}>{item.available === false ? '暂不可用于生成' : item.active ? '使用中' : busy === 'activate-' + item.id ? '切换中…' : '使用此预置模型'}</button>
            <button type="button" className="btn ghost" disabled={busy !== '' || !item.hasKey} onClick={() => { setBusy('test-' + item.id); void testProvider(item.id).then(result => notify(item.name + '：' + result.detail)).catch(() => notify('连接测试未完成，请稍后重试。')).finally(() => setBusy('')); }}>{busy === 'test-' + item.id ? '测试中…' : '重新测试连接'}</button>
          </div> : null}
          {!item.managed ? <p className="fine">{item.keyHint}</p> : null}
          {!item.managed ? <div className="composer-bar">
            {item.role === "model" ? (
              <button
                className="btn ghost"
                type="button"
                disabled={item.active || busy !== ""}
                title={!item.active && busy && busy !== `activate-${item.id}` ? "等当前测试或切换结束后再操作" : undefined}
                onClick={() => {
                  if (busy) return;
                  setBusy(`activate-${item.id}`);
                  void activateProvider(item.id)
                    .then(reload)
                    .then(() => notify(`已将「${item.name}」设为当前模型。`))
                    .catch(() => notify(`没能切换到「${item.name}」，请稍后再试。`))
                    .finally(() => setBusy(""));
                }}
              >
                {item.active ? "使用中" : busy === `activate-${item.id}` ? "正在切换" : "设为当前"}
              </button>
            ) : null}
            <button
              className="btn ghost"
              type="button"
              disabled={busy !== ""}
              aria-busy={busy === item.id || undefined}
              title={busy && busy !== item.id ? "等当前测试或切换结束后再操作" : undefined}
              onClick={() => {
                if (busy) return;
                setBusy(item.id);
                void testProvider(item.id)
                  .then((result) => notify(`${item.name}：${result.detail}${result.status ? ` HTTP ${result.status}` : ""}`))
                  .catch(() => notify(`${item.name}：没有连上测试服务，请确认本地服务已启动。`))
                  .finally(() => setBusy(""));
              }}
            >
              {busy === item.id ? "正在测试" : "测试连接"}
            </button>
            {item.id.startsWith("import-") ? (
              <button className="text-btn" type="button" onClick={() => void removeProvider(item.id).then(reload)}>
                移出
              </button>
            ) : null}
          </div> : null}
        </article>
      ))}
    </section>
  );
}

export function TasksPage() {
  const { state } = useStore();
  return (
    <div className="page">
      <p className="kicker">运行</p>
      <h1>任务中心</h1>
      <ul className="job-list">
        {state.jobs.map((job) => (
          <li key={job.id}>
            <span className={job.status === "succeeded" ? "judge judge-明确包含" : "judge judge-待确认"}>{job.status === "succeeded" ? "已完成" : "未执行"}</span>
            <div>
              <strong>{job.title}</strong>
              <p>{job.detail}</p>
              <small>{formatTime(job.at)} · {job.durationMs} ms</small>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SettingsPage() {
  const { state, dispatch, setView } = useStore();
  const [ask, setAsk] = useState(false);
  const downloadAudit = () => {
    const bundle = {
      exportedAt: new Date().toISOString(),
      cases: state.cases.map((patentCase) => ({ id: patentCase.id, title: patentCase.title, stage: patentCase.stage, audit: patentCase.audit })),
      jobs: state.jobs,
      knowledge: (state.knowledge ?? []).map((item) => ({ id: item.id, name: item.name, chars: item.chars })),
      model: { baseUrl: state.model.baseUrl, modelId: state.model.modelId, keyHint: state.model.keyHint },
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = "patentflow-audit.json";
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  };
  return (
    <div className="page page-narrow settings-page">
      <p className="kicker">设置</p>
      <h1>模型与数据</h1>
      <p className="lede">在这里查看模型与服务配置。知识库在左侧书本图标里，可以上传后一起载入对话。</p>
      <ModelsPage embedded />
      <article className="panel">
        <h2>知识库</h2>
        <p>私有 PDF 和文本可以先入库，再点“加入当前对话”。不会假装已经同步国家知识产权局。</p>
        <button className="btn ghost" type="button" onClick={() => { markKnowledgeBack("workbench"); setView("knowledge"); }}>打开知识库</button>
      </article>
      <article className="panel">
        <h2>材料与模型隐私</h2>
        <p>模型操作会将相关材料发送给当前模型服务；检索会发送查询词或网址，不发送整份案件正文。站点默认 Key 保存在服务端；个人 Key 默认仅保留在当前页面，使用时经本站网关转发。可选的标签页记忆并非加密存储，请勿在共享电脑上启用。</p>
      </article>
      <article className="panel">
        <h2>数据管理</h2>
        <div className="composer-bar">
          <button className="btn ghost" type="button" onClick={downloadAudit}>下载审计记录</button>
          <button className="btn ghost" type="button" onClick={() => dispatch({ type: "restore-demo" })}>恢复示范案件</button>
          <button className="text-btn danger" type="button" onClick={() => setAsk(true)}>清空全部数据</button>
        </div>
        {ask ? (
          <div className="confirm-row">
            <p>清空后，所有会话、知识库和记录都会被删除，且无法恢复。服务端密钥文件不会被这个按钮删除。</p>
            <button className="btn primary" type="button" onClick={() => { dispatch({ type: "wipe" }); setAsk(false); }}>确认清空</button>
            <button className="btn ghost" type="button" onClick={() => setAsk(false)}>取消</button>
          </div>
        ) : null}
      </article>
    </div>
  );
}
