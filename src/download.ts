/** Trigger a browser download for a generated file. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** A file name safe on Windows, macOS and Linux. */
export function safeFileName(value: string, fallback = "PatentFlow"): string {
  const clean = (input: string) => input
    .replace(/[\\/:*?"<>|\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/g, "");
  const candidate = clean(value) || clean(fallback) || "PatentFlow";
  const baseName = candidate.split(".", 1)[0].replace(/[. ]+$/g, "");
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(baseName)
    ? clean(`_${candidate}`)
    : candidate;
}
