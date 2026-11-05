/**
 * 读取用户上传的资料，统一转成可放进对话上下文的文字。
 * 支持 PDF、Word(.docx)、PPT(.pptx)、Excel(.xlsx/.xlsm)、CSV/TSV、Markdown/TXT、HTML、JSON/YAML/XML、代码文件和图片。
 * 图片不臆测内容：保留缩略图和尺寸，作为附图参考登记进资料。
 */
import { readPdf } from "./read-pdf.ts";
import { readZip } from "./zip.ts";
import { docxText, htmlText, sharedStrings, sheetRows, slideText, workbookSheets } from "./file-extract.ts";

export type FileFormat = "pdf" | "docx" | "pptx" | "xlsx" | "csv" | "html" | "json" | "markdown" | "text" | "code" | "image";

export interface PendingFile {
  id: string;
  name: string;
  kind: "pdf" | "text";
  text: string;
  chars: number;
  format?: FileFormat;
  /** 图片缩略图（data URL），只在上传时预览，不写入案件存档。 */
  preview?: string;
}

export const FORMAT_LABEL: Record<FileFormat, string> = {
  pdf: "PDF",
  docx: "Word",
  pptx: "PPT",
  xlsx: "Excel",
  csv: "表格",
  html: "网页",
  json: "数据",
  markdown: "Markdown",
  text: "文本",
  code: "代码",
  image: "图片",
};

const EXTENSIONS: Record<string, FileFormat> = {
  pdf: "pdf",
  docx: "docx",
  docm: "docx",
  pptx: "pptx",
  pptm: "pptx",
  xlsx: "xlsx",
  xlsm: "xlsx",
  csv: "csv",
  tsv: "csv",
  html: "html",
  htm: "html",
  xhtml: "html",
  json: "json",
  yaml: "json",
  yml: "json",
  xml: "json",
  md: "markdown",
  markdown: "markdown",
  txt: "text",
  text: "text",
  log: "text",
  tex: "text",
  py: "code",
  js: "code",
  jsx: "code",
  ts: "code",
  tsx: "code",
  java: "code",
  c: "code",
  h: "code",
  cc: "code",
  cpp: "code",
  hpp: "code",
  cs: "code",
  go: "code",
  rs: "code",
  m: "code",
  swift: "code",
  kt: "code",
  sql: "code",
  sh: "code",
  ps1: "code",
  vue: "code",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  svg: "image",
};

const LEGACY: Record<string, string> = {
  doc: "Word 97-2003（.doc）",
  ppt: "PowerPoint 97-2003（.ppt）",
  xls: "Excel 97-2003（.xls）",
  wps: "WPS 文字（.wps）",
  et: "WPS 表格（.et）",
  dps: "WPS 演示（.dps）",
};

export const UPLOAD_ACCEPT = [...Object.keys(EXTENSIONS).map((ext) => `.${ext}`), "application/pdf", "text/plain", "image/*"].join(",");
export const UPLOAD_HINT = "PDF、Word、PPT、Excel、CSV、Markdown、TXT、网页、JSON、代码和图片";
export const MAX_FILE_BYTES = 40 * 1024 * 1024;
export const MAX_TEXT_CHARS = 300_000;

type ReadResult = { ok: true; file: PendingFile } | { ok: false; reason: string };

export function extensionOf(name: string): string {
  return /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? "";
}

export function detectFormat(name: string, type = ""): FileFormat | null {
  const byExt = EXTENSIONS[extensionOf(name)];
  if (byExt) return byExt;
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("image/")) return "image";
  if (type === "text/html") return "html";
  if (type.startsWith("text/")) return "text";
  return null;
}

/** Decode text bytes: UTF-16 by BOM, then strict UTF-8, then GB18030 (common for Chinese .txt saved on Windows). */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    try {
      return new TextDecoder("gb18030").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 4096);
  for (let index = 0; index < end; index += 1) if (bytes[index] === 0) return true;
  return false;
}

/** Normalise line breaks and cap very long text so one file cannot flood the context. */
export function finishText(text: string): string {
  const clean = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if (clean.length <= MAX_TEXT_CHARS) return clean;
  return `${clean.slice(0, MAX_TEXT_CHARS)}\n\n…（文件过长，只保留前 ${MAX_TEXT_CHARS / 10000} 万字）`;
}

function stamp(): string {
  return `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const utf8 = new TextDecoder();

async function readDocx(data: ArrayBuffer): Promise<string> {
  const files = await readZip(data, (name) => name === "word/document.xml" || name === "word/footnotes.xml" || name === "word/endnotes.xml");
  const main = files.get("word/document.xml");
  if (!main) throw new Error("no document part");
  const blocks = [docxText(utf8.decode(main))];
  for (const [part, label] of [["word/footnotes.xml", "脚注"], ["word/endnotes.xml", "尾注"]] as const) {
    const xml = files.get(part);
    const text = xml ? docxText(utf8.decode(xml)) : "";
    if (text) blocks.push(`【${label}】\n${text}`);
  }
  return blocks.filter(Boolean).join("\n\n");
}

async function readPptx(data: ArrayBuffer): Promise<string> {
  const files = await readZip(data, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  let slides = [...files.entries()]
    .map(([name, xml]) => ({ no: Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0), lines: slideText(utf8.decode(xml)) }))
    .sort((a, b) => a.no - b.no);
  if (!slides.length) throw new Error("no slides");
  // Page labels alone are not extracted evidence from image-only slides.
  slides = slides.filter((slide) => slide.lines.some((line) => line.trim()));
  return slides.map((slide) => [`【第 ${slide.no} 页】`, ...slide.lines].join("\n")).join("\n\n");
}

async function readXlsx(data: ArrayBuffer): Promise<string> {
  const files = await readZip(data, (name) => name === "xl/workbook.xml" || name === "xl/_rels/workbook.xml.rels" || name === "xl/sharedStrings.xml" || /^xl\/worksheets\/[^/]+\.xml$/.test(name));
  const shared = files.get("xl/sharedStrings.xml") ? sharedStrings(utf8.decode(files.get("xl/sharedStrings.xml") as Uint8Array)) : [];
  const workbook = files.get("xl/workbook.xml");
  const rels = files.get("xl/_rels/workbook.xml.rels");
  let sheets = workbook && rels ? workbookSheets(utf8.decode(workbook), utf8.decode(rels)) : [];
  if (!sheets.length) {
    sheets = [...files.keys()].filter((name) => name.startsWith("xl/worksheets/")).sort().map((path, index) => ({ name: `工作表${index + 1}`, path }));
  }
  let budget = 3000;
  const blocks: string[] = [];
  for (const sheet of sheets) {
    const xml = files.get(sheet.path);
    if (!xml || budget <= 0) continue;
    const rows = sheetRows(utf8.decode(xml), shared, budget);
    budget -= rows.length;
    if (rows.length) blocks.push([`【工作表：${sheet.name}】`, ...rows].join("\n"));
  }
  if (budget <= 0) blocks.push("…（表格行数较多，只读取前 3000 行）");
  return blocks.join("\n\n");
}

async function readImage(file: File): Promise<{ text: string; preview: string }> {
  let width = 0;
  let height = 0;
  let preview = "";
  try {
    const bitmap = await createImageBitmap(file);
    width = bitmap.width;
    height = bitmap.height;
    const scale = Math.min(1, 360 / Math.max(width, height, 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      preview = canvas.toDataURL("image/jpeg", 0.72);
    }
    bitmap.close();
  } catch {
    // Some formats (e.g. SVG in older browsers) cannot be decoded to a bitmap; the file is still registered.
  }
  const size = width && height ? `（${width}×${height} 像素）` : "";
  let labels = "";
  if (extensionOf(file.name) === "svg") {
    const svg = await file.text();
    labels = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)].map((match) => htmlText(match[1])).filter(Boolean).join("、");
  }
  const text = [
    `【参考图片】${file.name}${size}`,
    "发明人上传的图片资料，可作为说明书附图的参考。系统不读取、也不臆测图片里的结构：请在对话中说明图中各部件的名称、位置和连接关系，撰写时会据此写附图说明和附图标记。",
    labels ? `图中文字标注：${labels}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { text, preview };
}

function fail(reason: string): ReadResult {
  return { ok: false, reason };
}

function done(name: string, format: FileFormat, raw: string, preview?: string): ReadResult {
  const text = finishText(raw);
  if (text.replace(/\s/g, "").length < 2) {
    return fail(format === "pdf" ? `《${name}》没有文字层，可能是扫描件。请上传可复制文字的 PDF 或 Word 版本。` : `《${name}》里没有可读取的文字。`);
  }
  return { ok: true, file: { id: stamp(), name, kind: format === "pdf" ? "pdf" : "text", text, chars: text.length, format, preview } };
}

export async function readUserFile(file: File): Promise<ReadResult> {
  const ext = extensionOf(file.name);
  if (LEGACY[ext]) return fail(`《${file.name}》是${LEGACY[ext]}旧格式，暂不能直接读取。请在 Office 或 WPS 中另存为 .docx / .pptx / .xlsx 后再上传。`);
  if (file.size === 0) return fail(`《${file.name}》是空文件。`);
  if (file.size > MAX_FILE_BYTES) return fail(`《${file.name}》超过 40 MB，请压缩或拆分后再上传。`);
  const format = detectFormat(file.name, file.type);
  try {
    if (!format) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (looksBinary(bytes)) return fail(`暂不支持《${file.name}》这种格式。可以上传：${UPLOAD_HINT}。`);
      return done(file.name, "text", decodeText(bytes));
    }
    switch (format) {
      case "pdf":
        return done(file.name, format, await readPdf(await file.arrayBuffer()));
      case "docx":
        return done(file.name, format, await readDocx(await file.arrayBuffer()));
      case "pptx":
        return done(file.name, format, await readPptx(await file.arrayBuffer()));
      case "xlsx":
        return done(file.name, format, await readXlsx(await file.arrayBuffer()));
      case "image": {
        const image = await readImage(file);
        return done(file.name, format, image.text, image.preview);
      }
      case "html":
        return done(file.name, format, htmlText(decodeText(new Uint8Array(await file.arrayBuffer()))));
      case "csv": {
        const text = decodeText(new Uint8Array(await file.arrayBuffer()));
        return done(file.name, format, ext === "tsv" ? text.replace(/\t/g, " | ") : text);
      }
      default:
        return done(file.name, format, decodeText(new Uint8Array(await file.arrayBuffer())));
    }
  } catch {
    if (format === "docx" || format === "pptx" || format === "xlsx") {
      return fail(`《${file.name}》没有读出来：文件可能已加密、损坏，或不是真正的 ${FORMAT_LABEL[format]} 文件。`);
    }
    return fail(`《${file.name}》没有读出来，请换一个格式再试。`);
  }
}
