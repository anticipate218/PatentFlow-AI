import test from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, docxText, htmlText, pptxText, sharedStrings, sheetRows, workbookSheets } from "./file-extract.ts";
import { decodeText, detectFormat, finishText } from "./read-user-file.ts";

test("decodeEntities handles named and numeric entities", () => {
  assert.equal(decodeEntities("a &lt; b &amp;&amp; c &#25130;&#x6C61;"), "a < b && c 截污");
});

test("docxText keeps paragraphs, tabs, breaks and table rows", () => {
  const xml = [
    '<w:document><w:body>',
    '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="420"/></w:tabs></w:pPr><w:r><w:t>一种雨水井</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">截污装置 &amp; 方法</w:t></w:r></w:p>',
    '<w:p/>',
    '<w:p><w:r><w:t>参数</w:t><w:tab/><w:t>0.3</w:t><w:br/><w:t>第二行</w:t></w:r></w:p>',
    '<w:tbl><w:tblPr/><w:tr><w:tc><w:p><w:r><w:t>部件</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>编号</w:t></w:r></w:p></w:tc></w:tr>',
    '<w:tr><w:tc><w:p><w:r><w:t>井框</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    '<w:sectPr><w:pgSz/></w:sectPr></w:body></w:document>',
  ].join("");
  assert.equal(docxText(xml), "一种雨水井截污装置 & 方法\n\n参数\t0.3\n第二行\n部件 | 编号\n井框 | 1");
});

test("pptxText orders slides and labels pages", () => {
  const slide = (text: string) => `<p:sld><a:p><a:r><a:t>${text}</a:t></a:r></a:p><a:p><a:r><a:t>要点</a:t></a:r></a:p></p:sld>`;
  assert.equal(pptxText([{ no: 2, xml: slide("第二页") }, { no: 1, xml: slide("标题") }]), "【第 1 页】\n标题\n要点\n\n【第 2 页】\n第二页\n要点");
});

test("xlsx shared strings, inline strings, gaps and sheet mapping", () => {
  const shared = sharedStrings('<sst><si><t>部件</t></si><si><r><t>井</t></r><r><t>框</t></r><rPh><t>ignored</t></rPh></si></sst>');
  assert.deepEqual(shared, ["部件", "井框"]);
  const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>备注</t></is></c></row><row r="2"/><row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><v>12.5</v></c><c r="C3" t="b"><v>1</v></c></row></sheetData></worksheet>';
  assert.deepEqual(sheetRows(sheet, shared), ["部件 |  | 备注", "井框 | 12.5 | TRUE"]);
  const sheets = workbookSheets(
    '<workbook><sheets><sheet name="参数&amp;尺寸" sheetId="1" r:id="rId1"/></sheets></workbook>',
    '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  assert.deepEqual(sheets, [{ name: "参数&尺寸", path: "xl/worksheets/sheet1.xml" }]);
});

test("xlsx shared strings preserve indexes of self-closing items", () => {
  const shared = sharedStrings('<sst><si/><si><t>alpha</t></si><si /><si><t>beta</t></si><si/></sst>');
  assert.deepEqual(shared, ["", "alpha", "", "beta", ""]);
  const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c><c r="B1" t="s"><v>3</v></c></row></sheetData></worksheet>';
  assert.deepEqual(sheetRows(sheet, shared), ["alpha | beta"]);
});

for (const empty of ['<t/>', '<t />', '<t xml:space="preserve"/>']) {
  test(`xlsx inline strings ignore self-closing text nodes: ${empty}`, () => {
    const inline = `<is><r>${empty}</r><r><t>alpha</t></r><r>${empty}</r><r><t xml:space="preserve"> &amp; beta</t></r><r>${empty}</r></is>`;
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr">${inline}</c><c r="B1" t="inlineStr"><is>${empty}</is></c><c r="C1"><v>7</v></c></row></sheetData></worksheet>`;
    assert.deepEqual(sheetRows(sheet, []), ["alpha & beta |  | 7"]);
  });
}

test("htmlText drops scripts and keeps structure", () => {
  const text = htmlText("<html><style>p{}</style><body><h1>标题</h1><p>第一段&nbsp;内容</p><script>x()</script><ul><li>甲</li><li>乙</li></ul></body></html>");
  assert.equal(text, "标题\n第一段 内容\n- 甲\n- 乙");
});

test("detectFormat and decodeText", () => {
  assert.equal(detectFormat("交底书.DOCX"), "docx");
  assert.equal(detectFormat("图1.png"), "image");
  assert.equal(detectFormat("数据.xlsx"), "xlsx");
  assert.equal(detectFormat("说明", "text/plain"), "text");
  assert.equal(detectFormat("archive.rar"), null);
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("中文")])), "中文");
  assert.equal(decodeText(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])), "中文");
  assert.equal(finishText("a\r\nb  \n\n\n\n\nc"), "a\nb\n\n\nc");
});
