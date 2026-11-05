import test from "node:test";
import assert from "node:assert/strict";
import { buildPackageZip, listPackage, preparePackageZip } from "./export-package.ts";
import { isAbortError, packageProgressText } from "./package-progress.ts";
import type { PackageProgress } from "./package-progress.ts";
import { listZip } from "./zip.ts";

const DRAFT = [
  "# 发明名称：一种雨水井截污装置",
  "",
  "## 说明书摘要",
  "本发明公开了一种雨水井截污装置，包括井框和弧形截污格栅，刮板由叶轮经曲柄连杆驱动沿格栅往复摆动，自动清除截留污物。",
  "",
  "## 权利要求书",
  "1. 一种雨水井截污装置，包括井框(1)，其特征在于，还包括截污格栅(2)和刮板(3)，所述刮板(3)由叶轮(4)驱动。",
  "2. 根据权利要求1所述的雨水井截污装置，其特征在于，所述截污格栅(2)呈弧形。",
  "",
  "## 技术领域",
  "本发明涉及市政排水设备技术领域。",
  "",
  "## 背景技术",
  "现有雨水井依赖人工清掏。【待检索补充对比文件】",
  "",
  "## 发明内容",
  "### 要解决的技术问题",
  "解决截污格栅易堵塞的问题。",
  "### 技术方案",
  "刮板由下泄水流驱动。",
  "### 有益效果",
  "无需外部电源即可自动清污。",
  "",
  "## 附图说明",
  "图1为本发明实施例的结构示意图。",
  "图2为截污格栅的剖视图。",
  "",
  "## 具体实施方式",
  "### 实施例1",
  "如图1所示，井框(1)下方设置截污格栅(2)。".repeat(30),
].join("\n");

function collect(): { events: PackageProgress[]; onProgress: (progress: PackageProgress) => void } {
  const events: PackageProgress[] = [];
  return { events, onProgress: (progress) => events.push({ ...progress }) };
}

function assertMonotonic(events: PackageProgress[]): void {
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index].overallDone >= events[index - 1].overallDone, `overallDone 不能回退：${index}`);
    assert.equal(events[index].overallTotal, events[0].overallTotal, "总量在一次打包中保持不变");
  }
  for (const event of events) {
    assert.ok(event.done >= 0 && event.done <= event.total, `${event.phase} ${event.done}/${event.total}`);
    assert.ok(event.overallDone >= 0 && event.overallDone <= event.overallTotal);
  }
}

test("buildPackageZip 逐份报告 Word 生成进度，最后报告压缩完成，压缩包内容不变", async () => {
  const listing = listPackage(DRAFT, "测试");
  const { events, onProgress } = collect();
  const zip = await buildPackageZip(listing.files, listing.title, listing.report, undefined, { onProgress });
  const documents = events.filter((event) => event.phase === "documents");
  assert.deepEqual(
    documents.filter((event) => event.done < event.total).map((event) => event.label),
    listing.files.map((file) => file.label),
  );
  assert.ok(documents.every((event) => event.total === listing.files.length));
  assert.equal(documents.at(-1)?.done, listing.files.length);
  const last = events.at(-1);
  assert.equal(last?.phase, "zip");
  assert.equal(last?.done, 1);
  assert.equal(last?.overallDone, last?.overallTotal);
  assert.equal(events[0].overallTotal, listing.files.length + 1);
  assertMonotonic(events);
  assert.equal(listZip(zip).length, listing.files.length + 1);
});

test("不传进度回调时行为与原来一致", async () => {
  const listing = listPackage(DRAFT, "测试");
  const zip = await buildPackageZip(listing.files, listing.title, listing.report);
  assert.equal(listZip(zip).length, listing.files.length + 1);
});

test("preparePackageZip 按 核对 → Word → 压缩 的顺序报告，没有绘图数据时不虚报附图阶段", async () => {
  const { events, onProgress } = collect();
  const result = await preparePackageZip(DRAFT, "测试", {}, { onProgress });
  assert.deepEqual([...new Set(events.map((event) => event.phase))], ["check", "documents", "zip"]);
  assert.equal(events[0].phase, "check");
  assert.equal(events[0].done, 1);
  const last = events.at(-1);
  assert.equal(last?.overallDone, last?.overallTotal);
  assertMonotonic(events);
  assert.equal(result.figureCount, 0);
  assert.equal(listZip(result.zip).length, result.fileCount + 1);
  assert.ok(result.report.exportable);
  assert.equal(result.title, "一种雨水井截污装置");
});

test("打包中途取消：立即停止，不再报告压缩阶段，错误可识别为取消", async () => {
  const listing = listPackage(DRAFT, "测试");
  const controller = new AbortController();
  const { events, onProgress } = collect();
  let built = 0;
  const files = listing.files.map((file) => ({ ...file, build: () => { built += 1; return file.build(); } }));
  await assert.rejects(
    buildPackageZip(files, listing.title, listing.report, undefined, {
      signal: controller.signal,
      onProgress: (progress) => {
        onProgress(progress);
        if (progress.phase === "documents" && progress.done === 1) controller.abort();
      },
    }),
    (error: unknown) => isAbortError(error),
  );
  assert.equal(events.filter((event) => event.phase === "zip").length, 0);
  assert.ok(built <= 2, `取消后不应继续构建：已构建 ${built} 份`);
});

test("信号已取消时一份文件都不构建", async () => {
  const listing = listPackage(DRAFT, "测试");
  const controller = new AbortController();
  controller.abort();
  let built = 0;
  const files = listing.files.map((file) => ({ ...file, build: () => { built += 1; return file.build(); } }));
  const { events, onProgress } = collect();
  await assert.rejects(buildPackageZip(files, listing.title, listing.report, undefined, { signal: controller.signal, onProgress }), (error: unknown) => isAbortError(error));
  await assert.rejects(preparePackageZip(DRAFT, "测试", {}, { signal: controller.signal, onProgress }), (error: unknown) => isAbortError(error));
  assert.equal(built, 0);
  assert.equal(events.length, 0);
});

test("不能导出的草稿报告普通失败，不当作取消", async () => {
  await assert.rejects(preparePackageZip("只是一段普通的聊天内容。", "测试"), (error: unknown) => error instanceof Error && !isAbortError(error) && error.message.length > 0);
  assert.equal(isAbortError(new Error("x")), false);
  assert.equal(isAbortError(null), false);
});

test("packageProgressText 给出当前步骤和真实计数", () => {
  const base = { overallDone: 0, overallTotal: 10 };
  assert.equal(packageProgressText({ ...base, phase: "check", done: 0, total: 1, label: "" }), "正在核对申请文件格式");
  assert.equal(packageProgressText({ ...base, phase: "figures", done: 1, total: 4, label: "图2" }), "正在绘制附图 2 / 4 · 图2");
  assert.equal(packageProgressText({ ...base, phase: "figures", done: 4, total: 4, label: "" }), "附图已全部绘制（4 幅）");
  assert.equal(packageProgressText({ ...base, phase: "documents", done: 4, total: 8, label: "说明书" }), "正在生成 Word 5 / 8 · 说明书");
  assert.equal(packageProgressText({ ...base, phase: "documents", done: 8, total: 8, label: "" }), "Word 已全部生成（8 份）");
  assert.equal(packageProgressText({ ...base, phase: "zip", done: 0, total: 1, label: "" }), "正在压缩打包");
  assert.equal(packageProgressText({ ...base, phase: "save", done: 0, total: 1, label: "" }), "正在保存到下载文件夹");
  assert.equal(packageProgressText({ ...base, phase: "done", done: 1, total: 1, label: "" }), "全套文件已生成");
});