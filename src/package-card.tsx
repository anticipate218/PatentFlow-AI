/** 发明专利申请文件卡片：分件列出全部 Word 文件，单个下载或一键打包下载；成稿后可继续提修改要求或撤销上次修改。 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PatentCase } from "./model.ts";
import { downloadPackageFile, downloadPackageZip, listPackage } from "./export-package.ts";
import { createJobLock, zipDoneState, zipStoppedState, zipView, ZIP_TIMEOUT_MS } from "./progress-view.ts";
import type { ZipState } from "./progress-view.ts";
import type { PackageProgress } from "./export-package.ts";
import type { PackageFile } from "./export-package.ts";
import { REVISE_QUICK_ACTIONS } from "./draft-revise.ts";
import { useStore } from "./store.tsx";

function short(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function PackageCard({
  patentCase,
  compact = false,
  busy = false,
  onRevise,
}: {
  patentCase: PatentCase;
  compact?: boolean;
  /** 当前有一轮对话在跑时为 true：修改和撤销都要等它结束。 */
  busy?: boolean;
  /** 把修改要求作为 /修改 发出；不传时不显示修改区。 */
  onRevise?: (instruction: string) => void;
}) {
  const { notify, dispatch } = useStore();
  const draft = patentCase.inventionDraft;
  const listing = useMemo(() => (draft?.text ? listPackage(draft.text, patentCase.title, { draft }) : null), [draft, patentCase.title]);
  const [working, setWorking] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [zip, setZip] = useState<ZipState | null>(null);
  const zipAbortRef = useRef<AbortController | null>(null);
  const [lock] = useState(createJobLock);
  const mountedRef = useRef(true);
  const zipBoxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      zipAbortRef.current?.abort();
    };
  }, []);
  // 取消、超时或失败后「取消」按钮消失，焦点会掉回页面：交给提示里第一个可用的按钮（重试 / 关闭），键盘用户不用从头找。
  const zipStatus = zip?.status ?? null;
  useEffect(() => {
    if (!zipStatus || zipStatus === "running") return;
    const focused = document.activeElement;
    if (focused && focused !== document.body) return;
    zipBoxRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, [zipStatus]);
  if (!draft?.text || !listing) return null;

  const chars = draft.text.replace(/\s/g, "").length;
  const revisions = draft.revisions ?? [];
  const lastRevision = revisions.at(-1);
  const undoDepth = draft.undo?.length ?? 0;
  const locked = busy || Boolean(working);
  const zipUi = zip ? zipView(zip) : null;

  const app = listing.app;
  const specNos = new Set((app?.figureSpecs ?? []).map((spec) => spec.no));
  const figureTotal = app?.figures.length ?? 0;
  const drawnTotal = app ? app.figures.filter((figure) => specNos.has(figure.no)).length : 0;
  const annotationTotal = app?.reviewAnnotations?.length ?? 0;
  const footNote = [
    !figureTotal
      ? "本稿没有附图。"
      : drawnTotal === figureTotal
        ? `附图 ${figureTotal} 幅均已按附图数据绘制并嵌入 Word。`
        : `附图 ${figureTotal} 幅中 ${drawnTotal} 幅已绘制，${figureTotal - drawnTotal} 幅缺少绘图数据，Word 中为空白虚线框，请按附图说明绘制后替换。`,
    draft.pendingMarks ? `${draft.pendingMarks} 处待补充事实在正式文件中已改写为正式表述，清单在内部审核单里，提交前须补充真实参数或数据。` : "",
    annotationTotal ? `${annotationTotal} 处推断或模拟值标注已从正式文件中去掉，清单在内部审核单里，提交前须逐项核实。` : "",
    "本稿是供代理师审核的初稿，不构成法律意见。",
  ]
    .filter(Boolean)
    .join("");
  const downloadOne = async (file: PackageFile) => {
    // 同步锁：打包或另一份下载进行中时直接忽略，连点也只启动一次。
    if (!lock.acquire(file.key)) return;
    setWorking(file.key);
    try {
      await downloadPackageFile(file, listing.title);
      notify(`已下载「${file.label}」。`);
    } catch (error) {
      notify(error instanceof Error ? `下载失败：${error.message}` : "下载失败。");
    } finally {
      lock.release(file.key);
      if (mountedRef.current) setWorking(null);
    }
  };

  const downloadAll = async () => {
    if (!lock.acquire("zip")) return;
    const abort = new AbortController();
    zipAbortRef.current = abort;
    let timedOut = false;
    let last: PackageProgress | null = null;
    const timer = window.setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, ZIP_TIMEOUT_MS);
    setWorking("zip");
    setZip({ status: "running", progress: null });
    try {
      const report = await downloadPackageZip(
        draft.text,
        patentCase.title,
        { draft },
        {
          signal: abort.signal,
          onProgress: (progress) => {
            last = progress;
            if (mountedRef.current) setZip({ status: "running", progress });
          },
        },
      );
      const done = zipDoneState(report);
      if (mountedRef.current) setZip(done);
      // 文件已经保存：即使卡片已关闭也告诉用户。
      notify(done.message);
    } catch (error) {
      // 卡片已卸载（切换会话等）时是卡片自己取消的：不再更新界面，也不弹「已取消」提示。
      if (mountedRef.current) {
        const stopped = zipStoppedState(error, timedOut, last);
        setZip(stopped);
        notify(stopped.message);
      }
    } finally {
      window.clearTimeout(timer);
      if (zipAbortRef.current === abort) zipAbortRef.current = null;
      lock.release("zip");
      if (mountedRef.current) setWorking(null);
    }
  };

  const cancelZip = () => {
    zipAbortRef.current?.abort();
  };

  const sendRevise = (value: string) => {
    const request = value.trim();
    if (!request || !onRevise || locked) return;
    onRevise(request);
    setInstruction("");
  };

  const undoLast = () => {
    if (!undoDepth || locked) return;
    dispatch({ type: "undo-invention-draft", caseId: patentCase.id });
    dispatch({
      type: "chat-note",
      caseId: patentCase.id,
      role: "assistant",
      text: `已撤销上次修改${lastRevision ? `（${short(lastRevision.instruction, 60)}）` : ""}，申请文件恢复到修改前的版本，卡片上的 Word 和打包下载同步恢复。${undoDepth > 1 ? `还可以再撤销 ${undoDepth - 1} 步。` : ""}`,
    });
    notify("已撤销上次修改。");
  };

  return (
    <section className={compact ? "pkg-card compact" : "pkg-card"} aria-label="发明专利申请文件">
      <header>
        <div>
          <h2>发明专利申请文件（初稿）</h2>
          <p>
            《{listing.title}》 · {chars} 字 · {draft.claimCount} 项权利要求 · 自检 {draft.score} 分 · 正文待补充标记 {draft.pendingMarks} 处 · 待核验事项 {draft.pending?.length ?? 0} 项
            {revisions.length ? ` · 已修改 ${revisions.length} 次` : ""}
          </p>
        </div>
        <button
          type="button"
          className="btn primary"
          disabled={Boolean(working) || listing.files.length === 0}
          title={listing.error || undefined}
          aria-busy={working === "zip"}
          onClick={() => void downloadAll()}
        >
          {working === "zip" ? "正在打包…" : listing.files.length ? "下载全套（zip）" : "需先修复后导出"}
        </button>
      </header>
      {zipUi ? (
        <div ref={zipBoxRef} className={`pkg-progress ${zipUi.tone}`} role={zipUi.role} aria-live={zipUi.live} aria-busy={zipUi.busy || undefined}>
          <div className="pkg-progress-row">
            <span className="pkg-progress-text">{zipUi.text}</span>
            {zipUi.showCancel ? (
              <button type="button" className="pkg-chip" onClick={cancelZip} aria-label="取消打包">
                取消
              </button>
            ) : null}
            {zipUi.showRetry ? (
              <button type="button" className="pkg-chip" disabled={Boolean(working) || listing.files.length === 0} onClick={() => void downloadAll()} aria-label="重试打包下载">
                重试
              </button>
            ) : null}
            {zipUi.showClose ? (
              <button type="button" className="pkg-chip" onClick={() => setZip(null)} aria-label="关闭打包提示">
                关闭
              </button>
            ) : null}
          </div>
          {zipUi.bar ? (
            <progress className="pkg-progress-bar" max={zipUi.bar.max} value={zipUi.bar.value} aria-label="打包进度" aria-valuetext={zipUi.bar.valueText} />
          ) : null}
        </div>
      ) : null}
      {listing.error ? (
        <p className="form-error">
          {listing.files.length
            ? `导出前形式核查未通过（文件仍可下载，问题已写入内部审核单）：${listing.error} 可以在对话里说“修复附图”自动修好。`
            : `暂不能导出：${listing.error} 可以在对话里说“修复附图”或指出要改的地方。`}
        </p>
      ) : null}
      <ul className="pkg-files">
        {listing.files.map((file) => (
          <li key={file.key} className="pkg-file">
            <span className="pkg-no">{file.no}</span>
            <span className="pkg-name">
              <b>{file.label}</b>
              <small>{file.note}</small>
            </span>
            <span className={file.filing ? "pkg-badge filing" : "pkg-badge"}>{file.filing ? "提交件" : "参考件"}</span>
            <button type="button" className="pkg-download" disabled={Boolean(working)} onClick={() => void downloadOne(file)} aria-label={`下载${file.label}`}>
              {working === file.key ? "生成中…" : "下载"}
            </button>
          </li>
        ))}
      </ul>
      <p className="pkg-foot">{footNote}</p>
      {onRevise ? (
        <form
          className="pkg-revise"
          aria-label="修改申请文件"
          onSubmit={(event) => {
            event.preventDefault();
            sendRevise(instruction);
          }}
        >
          <div className="pkg-revise-head">
            <b>继续修改</b>
            <span>
              {lastRevision
                ? `上次修改：${short(lastRevision.summary || lastRevision.instruction)}（自检 ${lastRevision.scoreBefore} → ${lastRevision.scoreAfter} 分）`
                : "只改你指出的地方，改完自动复核；结构或核查结果变差时保留原稿。"}
            </span>
          </div>
          <div className="pkg-revise-row">
            <textarea
              value={instruction}
              rows={2}
              disabled={busy}
              aria-label="修改要求"
              placeholder="例如：把权利要求1放宽，阈值改成范围（Ctrl+Enter 发送）"
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  sendRevise(instruction);
                }
              }}
            />
            <button type="submit" className="btn primary" disabled={locked || !instruction.trim()} aria-label="按要求修改申请文件">
              修改
            </button>
          </div>
          <div className="pkg-revise-quick">
            {REVISE_QUICK_ACTIONS.map((action) => (
              <button key={action.label} type="button" className="pkg-chip" disabled={locked} title={action.instruction} onClick={() => sendRevise(action.instruction)}>
                {action.label}
              </button>
            ))}
            <button
              type="button"
              className="pkg-chip undo"
              disabled={locked || !undoDepth}
              title={undoDepth ? `恢复到上次修改前的版本（可撤销 ${undoDepth} 步）` : "还没有可以撤销的修改"}
              aria-label={undoDepth ? `撤销上次修改，可撤销 ${undoDepth} 步` : "撤销上次修改（暂无可撤销的修改）"}
              onClick={undoLast}
            >
              撤销上次修改{undoDepth ? `（${undoDepth}）` : ""}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
