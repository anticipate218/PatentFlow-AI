/**
 * 进度卡片的显示逻辑（纯函数，不依赖 React，便于测试）：
 * - 生成进度：阶段文字、ARIA 取值、已用时间和“长时间没有新记录”提示，全部来自流水线真实发出的进度记录，不推算剩余时间或百分比；
 * - 打包下载：进行中 / 完成 / 失败 / 取消 / 超时各自的提示文字、按钮和进度条；
 * - 任务锁：同一张卡片同一时间只跑一个下载任务（单份下载与打包互斥），在界面重新渲染前连点也不会重复启动。
 */
import { formatElapsed } from "./run-progress.ts";
import type { ProgressStage, RunProgress, StageStatus } from "./run-progress.ts";
import { isAbortError, packageProgressText } from "./package-progress.ts";
import type { PackageProgress } from "./package-progress.ts";

/** 连续这么久没有新的进度记录时提示：撰写长文本时模型可能连续工作几分钟。 */
export const STALL_MS = 90_000;

/** 打包超过这么久仍未完成就中止：正常情况下几秒到几十秒即可完成。 */
export const ZIP_TIMEOUT_MS = 180_000;

export const STAGE_STATUS_TEXT: Record<StageStatus, string> = {
  done: "已完成",
  active: "进行中",
  pending: "未开始",
  skipped: "已跳过",
};

export interface RunStageRow {
  id: string;
  label: string;
  hint: string;
  status: StageStatus;
  /** 当前阶段：对应 aria-current="step"。 */
  current: boolean;
  /** 只给读屏的状态说明；跳过的阶段附上跳过原因。 */
  srText: string;
}

export interface RunProgressBar {
  /** 需要执行的阶段数（不含跳过的阶段），与「第 N / M 步」的 M 一致。 */
  max: number;
  /** 已完成的阶段数。 */
  now: number;
  valueText: string;
  /** 每个需要执行的阶段一段；跳过的阶段不占位。 */
  segments: Array<Pick<ProgressStage, "id" | "status">>;
}

export interface RunProgressView {
  regionLabel: string;
  title: string;
  stepText: string;
  elapsedText: string;
  elapsedLabel: string;
  bar: RunProgressBar | null;
  rows: RunStageRow[];
  latestText: string;
  attention: boolean;
  stalled: boolean;
  stallText: string;
}

/**
 * 生成进度卡片要显示的全部内容。
 * since 是本轮开始的时间，now 是当前时间（毫秒）。
 * “多久没有新记录”从最新一条记录和本轮开始中较晚的那个算起：本轮过滤允许约 1.5 秒的时钟误差，记录时间可能略早于开始时间。
 */
export function runProgressView(progress: RunProgress, since: number, now: number): RunProgressView {
  const active = progress.activeIndex >= 0 ? progress.stages[progress.activeIndex] : undefined;
  const counted = progress.stages.filter((stage) => stage.status !== "skipped");
  const elapsedText = formatElapsed(now - since);
  const lastSignal = Math.max(progress.latestAt ?? since, since);
  const quietFor = Math.max(0, now - lastSignal);
  const stalled = quietFor >= STALL_MS;
  const counts = `已完成 ${progress.done} 步，共 ${progress.total} 步`;
  return {
    regionLabel: `${progress.title}的进度`,
    title: progress.title,
    stepText: active ? `第 ${progress.step} / ${progress.total} 步 · ${active.label}` : "正在处理",
    elapsedText,
    elapsedLabel: `已用时 ${elapsedText}`,
    bar:
      progress.total > 0
        ? {
            max: progress.total,
            now: Math.min(Math.max(progress.done, 0), progress.total),
            valueText: active ? `${counts}；当前：${active.label}` : counts,
            segments: counted.map((stage) => ({ id: stage.id, status: stage.status })),
          }
        : null,
    rows: progress.stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      hint: stage.hint,
      status: stage.status,
      current: stage.status === "active",
      srText: `：${STAGE_STATUS_TEXT[stage.status]}${stage.status === "skipped" && stage.hint ? `，${stage.hint}` : ""}`,
    })),
    latestText: progress.latest || active?.hint || "正在处理…",
    attention: progress.attention,
    stalled,
    stallText: stalled
      ? `已有 ${formatElapsed(quietFor)}没有新的进度记录。撰写长文本时模型可能连续工作几分钟；可以继续等待，或点「停止」后重新发起。`
      : "",
  };
}

export type ZipState =
  | { status: "running"; progress: PackageProgress | null }
  | { status: "failed" | "cancelled" | "timeout"; message: string; progress: PackageProgress | null }
  | { status: "done"; message: string };

/** 打包已经结束（成功、失败、取消或超时）的状态。 */
export type ZipEnded = Exclude<ZipState, { status: "running" }>;

/** 停在哪一步：用最后一条真实进度说明；还没有进度时不写。 */
export function stoppedAt(progress: PackageProgress | null): string {
  return progress ? `（停在：${packageProgressText(progress)}）` : "";
}

export function zipDoneState(report: { errors: number; warnings: number }): ZipEnded {
  return { status: "done", message: `已下载全套申请文件。形式检查：${report.errors} 项需修改，${report.warnings} 项需注意。` };
}

/** 打包抛错后的状态：中止时区分超时和手动取消，其他错误都算失败。 */
export function zipStoppedState(error: unknown, timedOut: boolean, last: PackageProgress | null): ZipEnded {
  if (isAbortError(error)) {
    return timedOut
      ? {
          status: "timeout",
          message: `打包超过 ${Math.round(ZIP_TIMEOUT_MS / 1000)} 秒仍未完成，已中止${stoppedAt(last)}。可以重试，或先逐份下载。`,
          progress: last,
        }
      : { status: "cancelled", message: `已取消打包${stoppedAt(last)}，没有保存任何文件。`, progress: last };
  }
  const message = error instanceof Error ? `打包失败${stoppedAt(last)}：${error.message}` : `打包失败${stoppedAt(last)}。`;
  return { status: "failed", message, progress: last };
}

export interface ZipView {
  /** 对应 CSS 类 pkg-progress.running / done / failed / cancelled / timeout。 */
  tone: ZipState["status"];
  /** 进行中和完成是普通状态播报，失败、取消、超时是需要立即知道的提醒。 */
  role: "status" | "alert";
  live: "polite" | undefined;
  busy: boolean;
  text: string;
  showCancel: boolean;
  showRetry: boolean;
  showClose: boolean;
  bar: { max: number; value: number; valueText: string } | null;
}

export function zipView(zip: ZipState): ZipView {
  if (zip.status === "running") {
    const progress = zip.progress;
    const value = progress ? Math.min(Math.max(progress.overallDone, 0), progress.overallTotal) : 0;
    return {
      tone: "running",
      role: "status",
      live: "polite",
      busy: true,
      text: progress ? packageProgressText(progress) : "正在核对申请文件格式",
      showCancel: true,
      showRetry: false,
      showClose: false,
      bar: progress && progress.overallTotal > 0 ? { max: progress.overallTotal, value, valueText: `已完成 ${value} / ${progress.overallTotal} 步` } : null,
    };
  }
  if (zip.status === "done") {
    return { tone: "done", role: "status", live: "polite", busy: false, text: zip.message, showCancel: false, showRetry: false, showClose: true, bar: null };
  }
  return { tone: zip.status, role: "alert", live: undefined, busy: false, text: zip.message, showCancel: false, showRetry: true, showClose: true, bar: null };
}

export interface JobLock {
  /** 正在进行的任务；空闲时为 null。 */
  readonly current: string | null;
  /** 空闲时占用并返回 true；已有任务时返回 false，调用方应直接放弃。 */
  acquire(key: string): boolean;
  /** 只有占用者自己能释放；释放成功返回 true。 */
  release(key: string): boolean;
}

/** 同步任务锁：不等 React 重新渲染，第二次点击在同一帧里就会被拒绝。 */
export function createJobLock(): JobLock {
  let current: string | null = null;
  return {
    get current() {
      return current;
    },
    acquire(key: string) {
      if (current !== null) return false;
      current = key;
      return true;
    },
    release(key: string) {
      if (current !== key) return false;
      current = null;
      return true;
    },
  };
}
