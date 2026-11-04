import assert from "node:assert/strict";
import test from "node:test";
import { safeFileName } from "./download.ts";

test("safeFileName protects Windows device names with or without extensions", () => {
  for (const name of ["CON", "con.txt", "PRN.md", "AUX", "NUL.", "COM1.zip", "lpt9 .docx"]) {
    assert.ok(safeFileName(name).startsWith("_"), name);
  }
});

test("safeFileName removes trailing dots and spaces", () => {
  assert.equal(safeFileName("申请文件...   "), "申请文件");
  assert.equal(safeFileName("...", "备用文件."), "备用文件");
});

test("safeFileName preserves ordinary names and the length limit", () => {
  assert.equal(safeFileName("一种云检测方法"), "一种云检测方法");
  assert.equal(safeFileName("a".repeat(80)).length, 60);
});

test("safeFileName cleans trailing characters exposed by reserved-name truncation", () => {
  const expected = "_CON." + "a".repeat(54);
  for (const character of [".", " "]) {
    const input = "CON." + "a".repeat(54) + character + "a";
    assert.equal(input.length, 60);
    assert.equal(safeFileName(input), expected);
    assert.equal(safeFileName("", input), expected);
  }
});
