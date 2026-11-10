/**
 * 发明专利申请文件“分件”导出。
 *
 * 专利业务办理系统按部分分别上传申请文件，所以这里把同一份草稿拆成：
 *   01 发明专利请求书（信息表）  02 说明书摘要  03 摘要附图  04 权利要求书  05 说明书  06 说明书附图
 *   07 内部审核单（不提交）  08 合订稿（便于整体审阅）
 * 每个文件可单独下载，也可连同提交说明打成一个 zip。版式复用 export-docx 的各部分生成函数。
 */
import { AlignmentType, Document, Packer } from "docx";
import type { ISectionOptions } from "docx";
import type { FormalReport, ParsedApplication } from "./cnipa-format.ts";
import {
  EXPORT_DISCLAIMER,
  FONT,
  LINE,
  REQUEST_ITEMS,
  SIZE,
  SUBMIT_CHECKLIST,
  abstractFigureSection,
  abstractSection,
  buildApplicationDocument,
  claimsSection,
  descriptionSection,
  drawingsSection,
  heading,
  para,
  prepareApplication,
  reviewSection,
  section,
  table,
} from "./export-docx.ts";
import type { ApplicationExportOptions } from "./export-docx.ts";
import { saveBlob, safeFileName } from "./download.ts";
import { writeZip } from "./zip.ts";
import { drawableFigures, ensureFigureImages } from "./figure-assets.ts";
import type { FigureImage } from "./figure-assets.ts";
import type { PackagePhase, PackageProgress } from "./package-progress.ts";

export type PackageKey = "request" | "abstract" | "abstract-figure" | "claims" | "description" | "drawings" | "review" | "full";

export interface PackageFile {
  key: PackageKey;
  no: string;
  label: string;
  fileName: string;
  /** 提交国家知识产权局时上传的申请文件；false 为内部参考件。 */
  filing: boolean;
  note: string;
  build: () => Document;
  /** 构建前生成附图图像（异步栅格化并缓存）；下载单个文件或打包前调用。 */
  prepare?: () => Promise<void>;
}

export interface PackageListing {
  files: PackageFile[];
  report: FormalReport | null;
  title: string;
  error: string;
  /** 解析后的申请文件（打包附图图片时使用）。 */
  app?: ParsedApplication;
}

function makeDoc(title: string, sections: ISectionOptions[]): Document {
  return new Document({
    creator: "PatentFlow",
    title,
    description: "发明专利申请文件基础初稿（待专利代理师审核，不是正式申请文件）",
    styles: { default: { document: { run: { font: FONT, size: SIZE.body }, paragraph: { spacing: { line: LINE } } } } },
    sections,
  });
}

function abstractFigureNo(app: ParsedApplication): number | null {
  if (!app.figures.length) return null;
  return app.abstractFigure && app.figures.some((figure) => figure.no === app.abstractFigure) ? app.abstractFigure : app.figures[0].no;
}

/** 附图说明中列出且有绘图数据的图号。 */
function drawnNumbers(app: ParsedApplication): Set<number> {
  const specs = new Set((app.figureSpecs ?? []).map((spec) => spec.no));
  return new Set(app.figures.filter((figure) => specs.has(figure.no)).map((figure) => figure.no));
}

function drawingsNote(app: ParsedApplication): string {
  const drawn = drawnNumbers(app).size;
  const missing = app.figures.length - drawn;
  if (!missing) return `${app.figures.length} 幅，按绘图数据绘制为黑白线条图`;
  if (!drawn) return `${app.figures.length} 幅，缺少绘图数据，Word 中为占位，需按附图说明绘制`;
  return `${app.figures.length} 幅，${drawn} 幅按绘图数据绘制，${missing} 幅缺少绘图数据为占位`;
}

function abstractFigureNote(app: ParsedApplication, no: number): string {
  return drawnNumbers(app).has(no) ? `图${no}，与说明书附图中的图${no}相同` : `图${no}，缺少绘图数据，Word 中为占位`;
}

/** 附图 PNG 在压缩包中的位置（与 Word 中嵌入的图相同，300 dpi 白底黑线）。 */
export function figureImageName(no: number): string {
  return `附图/图${no}.png`;
}

function requestSection(app: ParsedApplication, report: FormalReport): ISectionOptions {
  const stats = report.stats;
  const figureNo = abstractFigureNo(app);
  return section("发明专利请求书（信息表）", [
    para("发明专利请求书 · 信息表", { align: AlignmentType.CENTER, bold: true, size: SIZE.title, after: 160 }),
    para("正式请求书须在国家知识产权局专利业务办理系统中在线填写，或使用国家知识产权局公布的最新版请求书表格。本表用于提前汇总填写所需的信息，本身不作为提交文件。", { after: 160 }),
    heading("一、请求书主要信息"),
    table(["项目", "内容"], [["专利类型", "发明"], ["发明名称", app.title || "—"], ...REQUEST_ITEMS.map((item) => [item, "在专利业务办理系统中填写"])], [42, 58]),
    heading("二、申请文件清单"),
    table(
      ["文件", "份数", "说明"],
      [
        ["说明书摘要", "1", `${stats.abstractChars} 字（不超过 300 字）`],
        ["摘要附图", figureNo ? "1" : "—", figureNo ? `说明书附图中的图${figureNo}` : "无附图"],
        ["权利要求书", "1", `${stats.claimCount} 项（独立权利要求 ${stats.independentCount} 项）`],
        ["说明书", "1", `${stats.descriptionChars} 字`],
        ["说明书附图", app.figures.length ? "1" : "—", app.figures.length ? drawingsNote(app) : "无附图"],
      ],
      [26, 10, 64],
    ),
    heading("三、说明"),
    para(EXPORT_DISCLAIMER, { indent: true }),
  ]);
}

/** The files of the filing package, in upload order. Builders are lazy: a Document is created only when downloaded. */
export function packageFiles(app: ParsedApplication, report: FormalReport, options: ApplicationExportOptions = {}): PackageFile[] {
  const title = app.title || "发明专利申请文件";
  const figureNo = abstractFigureNo(app);
  const items: Array<Omit<PackageFile, "no" | "fileName">> = [
    { key: "request", label: "发明专利请求书（信息表）", filing: false, note: "汇总请求书要填的信息，正式请求书在专利业务办理系统中填写", build: () => makeDoc(`${title}-请求书信息表`, [requestSection(app, report)]) },
    { key: "abstract", label: "说明书摘要", filing: true, note: `${report.stats.abstractChars} 字`, build: () => makeDoc(`${title}-说明书摘要`, [abstractSection(app)]) },
  ];
  const abstractFigure = abstractFigureSection(app);
  if (abstractFigure && figureNo) {
    items.push({ key: "abstract-figure", label: "摘要附图", filing: true, note: abstractFigureNote(app, figureNo), build: () => makeDoc(`${title}-摘要附图`, [abstractFigureSection(app) as ISectionOptions]) });
  }
  items.push(
    { key: "claims", label: "权利要求书", filing: true, note: `${report.stats.claimCount} 项权利要求`, build: () => makeDoc(`${title}-权利要求书`, [claimsSection(app)]) },
    { key: "description", label: "说明书", filing: true, note: `${report.stats.descriptionChars} 字，段落已编号`, build: () => makeDoc(`${title}-说明书`, [descriptionSection(app)]) },
  );
  if (drawingsSection(app)) {
    items.push({ key: "drawings", label: "说明书附图", filing: true, note: drawingsNote(app), build: () => makeDoc(`${title}-说明书附图`, [drawingsSection(app) as ISectionOptions]) });
  }
  items.push(
    { key: "review", label: "内部审核单", filing: false, note: "形式检查、待确认事项和提交前核对清单，不要上传", build: () => makeDoc(`${title}-内部审核单`, [reviewSection(app, report, options)]) },
    { key: "full", label: "合订稿（不含审核内容）", filing: false, note: "摘要、权利要求书、说明书和附图合在一个文件里，便于整体审阅；审核意见只在内部审核单中", build: () => buildApplicationDocument(app, report, { ...options, includeReview: false }) },
  );
  const prepare = async (): Promise<void> => {
    await ensureFigureImages(app);
  };
  return items.map((item, index) => {
    const no = String(index + 1).padStart(2, "0");
    return { ...item, no, fileName: `${no}-${item.label}.docx`, prepare };
  });
}

/** Parse and check a draft, then list its package. Never throws. */
export function listPackage(markdown: string, fallbackTitle: string, options: ApplicationExportOptions = {}): PackageListing {
  try {
    const { app, report } = prepareApplication(markdown, fallbackTitle);
    const title = app.title || fallbackTitle;
    if (!report.exportable) return { files: [], report, title, error: report.fatal, app };
    return { files: packageFiles(app, report, options), report, title, error: "", app };
  } catch (error) {
    return { files: [], report: null, title: fallbackTitle, error: error instanceof Error ? error.message : "草稿解析失败。" };
  }
}

export async function documentBytes(document: Document): Promise<Uint8Array> {
  if (typeof window === "undefined") return new Uint8Array(await Packer.toBuffer(document));
  return new Uint8Array(await (await Packer.toBlob(document)).arrayBuffer());
}

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function downloadPackageFile(file: PackageFile, title: string): Promise<void> {
  await file.prepare?.();
  const bytes = await documentBytes(file.build());
  saveBlob(new Blob([bytes as unknown as BlobPart], { type: DOCX_TYPE }), `${safeFileName(title, "发明专利申请文件")}-${file.fileName}`);
}

export function packageReadme(title: string, files: PackageFile[], report: FormalReport | null, figureNos: number[] = []): string {
  const filing = files.filter((file) => file.filing);
  const other = files.filter((file) => !file.filing);
  return [
    `《${title}》发明专利申请文件初稿`,
    "",
    "一、提交时上传的申请文件",
    ...filing.map((file) => `  ${file.fileName}  —— ${file.note}`),
    ...(figureNos.length ? [`  ${figureNos.map(figureImageName).join("、")}  —— 说明书附图的 300 dpi 黑白线条图，与 Word 中嵌入的图相同（系统要求单独上传附图图片时使用）`] : []),
    "",
    "二、内部参考（不要上传）",
    ...other.map((file) => `  ${file.fileName}  —— ${file.note}`),
    "",
    report ? `三、形式检查：${report.errors} 项需修改，${report.warnings} 项需注意，待确认标记 ${report.stats.pendingCount} 处。详见「内部审核单」。` : "三、形式检查：见「内部审核单」。",
    "",
    "四、提交前核对",
    ...SUBMIT_CHECKLIST.map((item, index) => `  ${index + 1}. ${item}`),
    "",
    EXPORT_DISCLAIMER,
    "",
  ].join("\r\n");
}

export interface PackageHooks {
  /** 每步开始或完成时调用；传入后每步之间会让出一次事件循环，便于页面重绘。 */
  onProgress?: (progress: PackageProgress) => void;
  /** 取消后在下一个步骤边界停止，并以 AbortError 结束；已经保存的文件不会被报为取消。 */
  signal?: AbortSignal;
}

export interface PreparedPackageZip {
  zip: Uint8Array;
  report: FormalReport;
  title: string;
  /** 压缩包中的 Word 份数。 */
  fileCount: number;
  /** 压缩包中的附图 PNG 幅数。 */
  figureCount: number;
}

const PHASE_ORDER: PackagePhase[] = ["check", "figures", "documents", "zip", "save", "done"];
type PhasePlan = Partial<Record<PackagePhase, number>>;

function abortError(): Error {
  const error = new Error("已取消打包。");
  error.name = "AbortError";
  return error;
}

/** 让浏览器有机会重绘进度：生成 Word 和压缩都是同步的重计算。 */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface ProgressRun {
  emit: (phase: PackagePhase, done: number, total: number, label?: string) => Promise<void>;
  /** 信号已取消时抛出 AbortError。 */
  checkpoint: () => void;
  /** 上报“完成”：文件已经保存，不再检查取消。 */
  finish: () => void;
}

function progressRun(hooks: PackageHooks, plan: PhasePlan): ProgressRun {
  const offsets = new Map<PackagePhase, number>();
  let overallTotal = 0;
  for (const phase of PHASE_ORDER) {
    offsets.set(phase, overallTotal);
    overallTotal += plan[phase] ?? 0;
  }
  let last = 0;
  const checkpoint = () => {
    if (hooks.signal?.aborted) throw abortError();
  };
  const report = (phase: PackagePhase, done: number, total: number, label: string) => {
    const size = plan[phase] ?? 0;
    const overallDone = Math.min(overallTotal, Math.max(last, (offsets.get(phase) ?? 0) + Math.min(Math.max(done, 0), size)));
    last = overallDone;
    hooks.onProgress?.({ phase, done, total, label, overallDone, overallTotal });
  };
  return {
    checkpoint,
    async emit(phase, done, total, label = "") {
      checkpoint();
      if (!hooks.onProgress) return;
      report(phase, done, total, label);
      await yieldToUi();
      checkpoint();
    },
    finish() {
      if (hooks.onProgress) report("done", 1, 1, "");
    },
  };
}

async function buildZipWith(
  run: ProgressRun,
  files: PackageFile[],
  title: string,
  report: FormalReport | null,
  figures: Map<number, FigureImage>,
): Promise<Uint8Array> {
  const folder = safeFileName(title, "发明专利申请文件");
  const entries = [];
  for (const [index, file] of files.entries()) {
    await run.emit("documents", index, files.length, file.label);
    await file.prepare?.();
    run.checkpoint();
    entries.push({ name: `${folder}/${file.fileName}`, data: await documentBytes(file.build()) });
  }
  await run.emit("documents", files.length, files.length);
  const figureNos = [...figures.keys()].sort((a, b) => a - b);
  const pictures = figureNos.map((no) => ({ name: `${folder}/${figureImageName(no)}`, data: (figures.get(no) as FigureImage).png }));
  const readme = new TextEncoder().encode(`\uFEFF${packageReadme(title, files, report, figureNos)}`);
  await run.emit("zip", 0, 1, "压缩打包");
  const zip = await writeZip([{ name: `${folder}/00-提交说明.txt`, data: readme }, ...entries, ...pictures]);
  await run.emit("zip", 1, 1);
  return zip;
}

export async function buildPackageZip(
  files: PackageFile[],
  title: string,
  report: FormalReport | null,
  figures: Map<number, FigureImage> = new Map(),
  hooks: PackageHooks = {},
): Promise<Uint8Array> {
  return buildZipWith(progressRun(hooks, { documents: files.length, zip: 1 }), files, title, report, figures);
}

async function prepareZip(
  markdown: string,
  fallbackTitle: string,
  options: ApplicationExportOptions,
  hooks: PackageHooks,
  withSave: boolean,
): Promise<{ result: PreparedPackageZip; run: ProgressRun }> {
  if (hooks.signal?.aborted) throw abortError();
  const listing = listPackage(markdown, fallbackTitle, options);
  if (!listing.report || listing.error) throw new Error(listing.error || "草稿解析失败。");
  const drawable = listing.app ? drawableFigures(listing.app) : [];
  const run = progressRun(hooks, { check: 1, figures: drawable.length, documents: listing.files.length, zip: 1, save: withSave ? 1 : 0 });
  await run.emit("check", 1, 1, "形式检查");
  let figures = new Map<number, FigureImage>();
  if (listing.app && drawable.length) {
    const prepared = await ensureFigureImages(listing.app, undefined, {
      signal: hooks.signal,
      onFigure: (done, total, no) => run.emit("figures", done, total, `图${no}`),
    });
    run.checkpoint();
    figures = prepared.images;
    await run.emit("figures", drawable.length, drawable.length);
  }
  const zip = await buildZipWith(run, listing.files, listing.title, listing.report, figures);
  return {
    result: { zip, report: listing.report, title: listing.title, fileCount: listing.files.length, figureCount: figures.size },
    run,
  };
}

/** 校验并生成全套压缩包（不保存）。不能导出时抛出普通错误，取消时抛出 AbortError。 */
export async function preparePackageZip(
  markdown: string,
  fallbackTitle: string,
  options: ApplicationExportOptions = {},
  hooks: PackageHooks = {},
): Promise<PreparedPackageZip> {
  return (await prepareZip(markdown, fallbackTitle, options, hooks, false)).result;
}

/** Validate, build every part and download the whole package as one zip. */
export async function downloadPackageZip(
  markdown: string,
  fallbackTitle: string,
  options: ApplicationExportOptions = {},
  hooks: PackageHooks = {},
): Promise<FormalReport> {
  const { result, run } = await prepareZip(markdown, fallbackTitle, options, hooks, true);
  const fileName = `${safeFileName(result.title, "发明专利申请文件")}-申请文件全套.zip`;
  await run.emit("save", 0, 1, fileName);
  saveBlob(new Blob([result.zip as unknown as BlobPart], { type: "application/zip" }), fileName);
  run.finish();
  return result.report;
}
