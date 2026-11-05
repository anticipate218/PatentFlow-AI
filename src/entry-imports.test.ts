import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * 首屏脚本只应包含打开页面所需的代码。Word 生成（docx）和 PDF 读取（pdfjs-dist）体积大，只在导出或读取 PDF 时用到，
 * 页面用 import() 按需加载它们；但只要入口沿静态 import 能走到其中任何一个，打包器就会把它并进首屏脚本，按需加载随之失效。
 * 这里从 index.html 引用的 src/main.tsx 出发，沿会保留到运行时的 import / export ... from 遍历
 * （verbatimModuleSyntax 下只有 import type / export type 会被删除；import() 本来就是按需加载，不计入）。
 */
const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SRC);
const ENTRY = path.join(SRC, "main.tsx");
const LAZY_ONLY = ["docx", "pdfjs-dist"];

function runtimeSpecifiers(file: string): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, kind);
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

/** 相对路径解析成源码文件；样式、图片等资源返回 null。 */
function resolveSource(from: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(from), specifier.split("?")[0]);
  const candidate = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")].find(
    (file) => /\.tsx?$/.test(file) && existsSync(file),
  );
  return candidate ?? null;
}

/** 广度优先遍历，记下每个外部包第一次被引入时最短的引用链。 */
function staticImportChains(entry: string): Map<string, string[]> {
  const label = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
  const chains = new Map<string, string[]>();
  const seen = new Map<string, string[]>([[entry, [label(entry)]]]);
  const queue = [entry];
  for (let file = queue.shift(); file; file = queue.shift()) {
    const chain = seen.get(file) ?? [];
    for (const specifier of runtimeSpecifiers(file)) {
      if (specifier.startsWith(".")) {
        const next = resolveSource(file, specifier);
        if (next && !seen.has(next)) {
          seen.set(next, [...chain, label(next)]);
          queue.push(next);
        }
      } else if (!chains.has(specifier)) {
        chains.set(specifier, [...chain, specifier]);
      }
    }
  }
  return chains;
}

test("首屏脚本不静态引入 docx 和 pdfjs-dist，导出和读取 PDF 保持按需加载", () => {
  const chains = staticImportChains(ENTRY);
  // 遍历确实覆盖了页面代码：react-dom 由 main.tsx 引入，React 组件遍布各模块。
  assert.ok(chains.has("react-dom/client"), "没有从 main.tsx 读到任何外部包");
  assert.ok(chains.has("react"), "没有沿相对路径遍历到页面组件");
  for (const pkg of LAZY_ONLY) {
    const hits = [...chains].filter(([specifier]) => specifier === pkg || specifier.startsWith(`${pkg}/`));
    assert.deepEqual(
      hits.map(([, chain]) => chain.join(" → ")),
      [],
      `${pkg} 会被打进首屏脚本；请改用 import()，或把首屏需要的轻量代码移到不引用 ${pkg} 的模块`,
    );
  }
});
