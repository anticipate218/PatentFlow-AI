/**
 * Office / HTML 文本抽取（纯函数，便于测试）。输入是解压后的 XML 或 HTML 字符串。
 * 只做文字层抽取：段落、表格（按行，单元格用“ | ”分隔）、幻灯片文本框和工作表单元格。
 */

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const value = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
    }
    return ENTITY[code.toLowerCase()] ?? whole;
  });
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function tidy(lines: string[]): string {
  return lines
    .map((line) => line.replace(/[ \t\u00a0]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wordRuns(xml: string): string {
  let out = "";
  for (const match of xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>/g)) {
    if (match[1] !== undefined) out += decodeEntities(match[1]);
    else if (match[0].startsWith("<w:tab")) out += "\t";
    else out += "\n";
  }
  return out;
}

function wordParagraphs(xml: string): string[] {
  return [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map((match) => wordRuns(match[1]));
}

/** Text of word/document.xml (or footnotes.xml): one line per paragraph, one line per table row. */
export function docxText(xml: string): string {
  const start = xml.indexOf("<w:body");
  let body = start >= 0 ? xml.slice(start) : xml;
  body = body
    .replace(/<w:(pPr|rPr|sectPr|tblPr|trPr|tcPr|tblGrid)\b[^>]*\/>/g, "")
    .replace(/<w:(pPr|rPr|sectPr|tblPr|trPr|tcPr|tblGrid)\b[^>]*>[\s\S]*?<\/w:\1>/g, "")
    .replace(/<w:t\b[^>]*\/>/g, "")
    .replace(/<w:p\b([^>]*)\/>/g, "<w:p$1></w:p>");
  body = body.replace(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g, (table) => {
    const rows = [...table.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)].map((row) =>
      [...row[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)]
        .map((cell) => wordParagraphs(cell[1]).join(" ").replace(/\s+/g, " ").trim())
        .join(" | "),
    );
    return rows.map((row) => `<w:p><w:r><w:t>${escapeXml(row)}</w:t></w:r></w:p>`).join("");
  });
  return tidy(wordParagraphs(body));
}

/** Lines of one slide (ppt/slides/slideN.xml). */
export function slideText(xml: string): string[] {
  return [...xml.replace(/<a:p\b[^>]*\/>/g, "").matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
    .map((paragraph) => {
      let line = "";
      for (const match of paragraph[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/?>/g)) {
        line += match[1] !== undefined ? decodeEntities(match[1]) : "\n";
      }
      return line.trim();
    })
    .filter(Boolean);
}

export function pptxText(slides: Array<{ no: number; xml: string }>): string {
  return [...slides]
    .sort((a, b) => a.no - b.no)
    .map((slide) => [`【第 ${slide.no} 页】`, ...slideText(slide.xml)].join("\n"))
    .join("\n\n")
    .trim();
}

export function sharedStrings(xml: string): string[] {
  return [...xml.replace(/<si\b[^>]*\/>/g, "<si></si>").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((item) => {
    const body = item[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").replace(/<t\b[^>]*\/>/g, "");
    return [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((text) => decodeEntities(text[1])).join("");
  });
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "";
  let value = 0;
  for (const char of letters) value = value * 26 + (char.charCodeAt(0) - 64);
  return value - 1;
}

/** Rows of one worksheet as “a | b | c” lines; empty rows are skipped. */
export function sheetRows(xml: string, shared: string[], maxRows = 1500): string[] {
  const rows: string[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= maxRows) break;
    const cells: string[] = [];
    for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1];
      const inner = cell[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/i.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = "";
      if (type === "s") value = raw !== undefined ? shared[Number(raw)] ?? "" : "";
      else if (type === "inlineStr") value = [...inner.replace(/<t\b[^>]*\/>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((text) => decodeEntities(text[1])).join("");
      else if (type === "b") value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : "";
      else value = raw !== undefined ? decodeEntities(raw) : "";
      const index = ref ? Math.min(columnIndex(ref), 200) : cells.length;
      while (cells.length < index) cells.push("");
      cells[index] = value.replace(/\s+/g, " ").trim();
    }
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    if (cells.some(Boolean)) rows.push(cells.join(" | "));
  }
  return rows;
}

/** Sheet names and their part paths, in workbook order. */
export function workbookSheets(workbookXml: string, relsXml: string): Array<{ name: string; path: string }> {
  const rels = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)>/g)) {
    const id = /\bId="([^"]+)"/.exec(match[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(match[1])?.[1];
    if (id && target) rels.set(id, target);
  }
  const sheets: Array<{ name: string; path: string }> = [];
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)>/g)) {
    const name = decodeEntities(/\bname="([^"]*)"/.exec(match[1])?.[1] ?? "");
    const rid = /\br:id="([^"]+)"/.exec(match[1])?.[1];
    const target = rid ? rels.get(rid) : undefined;
    if (!target) continue;
    sheets.push({ name, path: target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}` });
  }
  return sheets;
}

export function htmlText(html: string): string {
  const plain = html
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|table|header|footer)>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "");
  return tidy(decodeEntities(plain).split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()));
}
