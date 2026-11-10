import assert from "node:assert/strict";
import test from "node:test";
import { packageProgressText } from "./package-progress.ts";
import type { PackageProgress } from "./package-progress.ts";
import type { ProgressStage, RunProgress, StageStatus } from "./run-progress.ts";
import { createJobLock, runProgressView, STALL_MS, stoppedAt, ZIP_TIMEOUT_MS, zipDoneState, zipStoppedState, zipView } from "./progress-view.ts";
import type { ZipState } from "./progress-view.ts";

const stage = (id: string, label: string, status: StageStatus, hint = `${label}说明`): ProgressStage => ({ id, label, hint, status });

function makeProgress(stages: ProgressStage[], extra: Partial<RunProgress> = {}): RunProgress {
  const counted = stages.filter((item) => item.status !== "skipped");
  const activeIndex = stages.findIndex((item) => item.status === "active");
  return {
    kind: "auto",
    title: "全自动成稿",
    stages,
    done: counted.filter((item) => item.status === "done").length,
    total: counted.length,
    activeIndex,
    activeLabel: activeIndex >= 0 ? stages[activeIndex].label : "",
    step: activeIndex >= 0 ? counted.indexOf(stages[activeIndex]) + 1 : 0,
    latest: "",
    latestAt: null,
    attention: false,
    traceCount: 0,
    ...extra,
  };
}

const autoStages = () => [
  stage("topic", "选题", "done"),
  stage("novelty", "查新", "skipped", "已有查新报告，跳过"),
  stage("outline", "大纲", "active"),
  stage("write", "撰写", "pending"),
  stage("audit", "核查", "pending"),
  stage("figures", "附图", "pending"),
  stage("polish", "润色", "pending"),
];

const SINCE = 1_000_000;

test("runProgressView: step text, ARIA values and segments exclude skipped stages", () => {
  const view = runProgressView(makeProgress(autoStages()), SINCE, SINCE + 5_000);
  assert.equal(view.regionLabel, "全自动成稿的进度");
  assert.equal(view.stepText, "第 2 / 6 步 · 大纲");
  assert.ok(view.bar);
  assert.equal(view.bar.max, 6);
  assert.equal(view.bar.now, 1);
  assert.equal(view.bar.valueText, "已完成 1 步，共 6 步；当前：大纲");
  assert.deepEqual(
    view.bar.segments.map((segment) => segment.id),
    ["topic", "outline", "write", "audit", "figures", "polish"],
  );
  assert.equal(view.rows.length, 7);
  assert.equal(view.rows[0].srText, "：已完成");
  assert.equal(view.rows[1].srText, "：已跳过，已有查新报告，跳过");
  assert.equal(view.rows[1].status, "skipped");
  assert.equal(view.rows[2].srText, "：进行中");
  assert.equal(view.rows[3].srText, "：未开始");
  assert.deepEqual(
    view.rows.filter((row) => row.current).map((row) => row.id),
    ["outline"],
  );
});

test("runProgressView: elapsed time is real wall time and never negative", () => {
  const progress = makeProgress(autoStages());
  const view = runProgressView(progress, SINCE, SINCE + 125_000);
  assert.equal(view.elapsedText, "2 分 05 秒");
  assert.equal(view.elapsedLabel, "已用时 2 分 05 秒");
  const skewed = runProgressView(progress, SINCE, SINCE - 3_000);
  assert.equal(skewed.elapsedText, "0 秒");
  assert.equal(skewed.stalled, false);
  assert.equal(skewed.stallText, "");
});

test("runProgressView: stall note appears only after STALL_MS without a new record", () => {
  const latestAt = SINCE + 10_000;
  const progress = makeProgress(autoStages(), { latest: "正在生成大纲", latestAt });
  assert.equal(runProgressView(progress, SINCE, latestAt + STALL_MS - 1).stalled, false);
  const stalled = runProgressView(progress, SINCE, latestAt + STALL_MS);
  assert.equal(stalled.stalled, true);
  assert.match(stalled.stallText, /^已有 1 分 30 秒没有新的进度记录。/);
  assert.match(stalled.stallText, /「停止」/);

  // 还没有记录：从本轮开始算起。
  const empty = makeProgress(autoStages());
  assert.equal(runProgressView(empty, SINCE, SINCE + STALL_MS - 1).stalled, false);
  assert.equal(runProgressView(empty, SINCE, SINCE + STALL_MS).stalled, true);

  // 记录时间因时钟误差略早于本轮开始：仍从本轮开始算，不提前提示。
  const early = makeProgress(autoStages(), { latest: "开始", latestAt: SINCE - 1_000 });
  assert.equal(runProgressView(early, SINCE, SINCE + STALL_MS - 1).stalled, false);
  const earlyStalled = runProgressView(early, SINCE, SINCE + STALL_MS);
  assert.equal(earlyStalled.stalled, true);
  assert.match(earlyStalled.stallText, /^已有 1 分 30 秒/);
});

test("runProgressView: latest text falls back to the active hint, attention passes through", () => {
  assert.equal(runProgressView(makeProgress(autoStages()), SINCE, SINCE).latestText, "大纲说明");
  const view = runProgressView(makeProgress(autoStages(), { latest: "撰写超时，正在重试", latestAt: SINCE + 1, attention: true }), SINCE, SINCE + 2);
  assert.equal(view.latestText, "撰写超时，正在重试");
  assert.equal(view.attention, true);
});

test("runProgressView: no executable stage means no progress bar and a neutral text", () => {
  const view = runProgressView(makeProgress([stage("novelty", "查新", "skipped", "")]), SINCE, SINCE + 1_000);
  assert.equal(view.bar, null);
  assert.equal(view.stepText, "正在处理");
  assert.equal(view.latestText, "正在处理…");
  assert.equal(view.rows[0].srText, "：已跳过");
});

test("runProgressView: all stages finished keeps counts consistent", () => {
  const stages = autoStages().map((item) => (item.status === "skipped" ? item : { ...item, status: "done" as const }));
  const view = runProgressView(makeProgress(stages), SINCE, SINCE + 1_000);
  assert.ok(view.bar);
  assert.equal(view.bar.now, view.bar.max);
  assert.equal(view.bar.valueText, "已完成 6 步，共 6 步");
  assert.equal(view.stepText, "正在处理");
});

const figuresStep: PackageProgress = { phase: "figures", done: 2, total: 5, label: "图3", overallDone: 3, overallTotal: 12 };

test("zipView: running without progress yet shows the first real step and only a cancel button", () => {
  const view = zipView({ status: "running", progress: null });
  assert.equal(view.text, "正在核对申请文件格式");
  assert.equal(view.role, "status");
  assert.equal(view.live, "polite");
  assert.equal(view.busy, true);
  assert.deepEqual([view.showCancel, view.showRetry, view.showClose], [true, false, false]);
  assert.equal(view.bar, null);
});

test("zipView: running with progress uses real counts and clamps the bar", () => {
  const view = zipView({ status: "running", progress: figuresStep });
  assert.equal(view.text, packageProgressText(figuresStep));
  assert.deepEqual(view.bar, { max: 12, value: 3, valueText: "已完成 3 / 12 步" });
  const over = zipView({ status: "running", progress: { ...figuresStep, overallDone: 15 } });
  assert.deepEqual(over.bar, { max: 12, value: 12, valueText: "已完成 12 / 12 步" });
  const empty = zipView({ status: "running", progress: { ...figuresStep, overallDone: 0, overallTotal: 0 } });
  assert.equal(empty.bar, null);
});

test("zipStoppedState: timeout, cancel and failure are told apart", () => {
  const abort = () => new DOMException("已取消打包。", "AbortError");
  assert.equal(stoppedAt(null), "");
  assert.equal(stoppedAt(figuresStep), `（停在：${packageProgressText(figuresStep)}）`);

  const timeout = zipStoppedState(abort(), true, figuresStep);
  assert.equal(timeout.status, "timeout");
  assert.equal(timeout.message, `打包超过 ${ZIP_TIMEOUT_MS / 1000} 秒仍未完成，已中止${stoppedAt(figuresStep)}。可以重试，或先逐份下载。`);
  assert.ok("progress" in timeout && timeout.progress === figuresStep);

  const cancelled = zipStoppedState(abort(), false, null);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.message, "已取消打包，没有保存任何文件。");

  const failed = zipStoppedState(new Error("磁盘已满"), false, figuresStep);
  assert.equal(failed.status, "failed");
  assert.equal(failed.message, `打包失败${stoppedAt(figuresStep)}：磁盘已满`);

  // 超时计时已到但抛出的是普通错误：按真实错误报失败，不冒充超时。
  assert.equal(zipStoppedState(new Error("写入失败"), true, null).status, "failed");
  assert.equal(zipStoppedState("boom", false, null).message, "打包失败。");
});

test("zipView: ended states offer retry and close, done offers close only", () => {
  for (const status of ["failed", "cancelled", "timeout"] as const) {
    const view = zipView({ status, message: "m", progress: null });
    assert.equal(view.tone, status);
    assert.equal(view.role, "alert");
    assert.equal(view.live, undefined);
    assert.equal(view.busy, false);
    assert.deepEqual([view.showCancel, view.showRetry, view.showClose], [false, true, true]);
    assert.equal(view.bar, null);
  }
  const done = zipDoneState({ errors: 0, warnings: 2 });
  assert.equal(done.message, "已下载全套申请文件。形式检查：0 项需修改，2 项需注意。");
  const view = zipView(done);
  assert.equal(view.role, "status");
  assert.deepEqual([view.showCancel, view.showRetry, view.showClose], [false, false, true]);
});

test("progress texts never show percentages", () => {
  const states: ZipState[] = [
    { status: "running", progress: null },
    { status: "running", progress: figuresStep },
    zipDoneState({ errors: 1, warnings: 0 }),
    zipStoppedState(new DOMException("x", "AbortError"), true, figuresStep),
  ];
  for (const state of states) assert.doesNotMatch(JSON.stringify(zipView(state)), /%/);
  const progress = makeProgress(autoStages(), { latest: "正在撰写", latestAt: SINCE });
  assert.doesNotMatch(JSON.stringify(runProgressView(progress, SINCE, SINCE + STALL_MS * 2)), /%/);
});

test("createJobLock: one job at a time, only the owner releases", () => {
  const lock = createJobLock();
  assert.equal(lock.current, null);
  assert.equal(lock.acquire("zip"), true);
  // 同一帧内的第二次点击和单份下载都被拒绝。
  assert.equal(lock.acquire("zip"), false);
  assert.equal(lock.acquire("claims"), false);
  assert.equal(lock.current, "zip");
  assert.equal(lock.release("claims"), false);
  assert.equal(lock.current, "zip");
  assert.equal(lock.release("zip"), true);
  assert.equal(lock.current, null);
  assert.equal(lock.release("zip"), false);
  assert.equal(lock.acquire("claims"), true);
  assert.equal(lock.acquire("zip"), false);
  assert.equal(lock.release("claims"), true);
});
