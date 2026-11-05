import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Document, Packer, Paragraph } from 'docx';
import { readUserFile } from './read-user-file.ts';
import { writeZip } from './zip.ts';

test('uploaded text-layer PDF is actually decoded through the file reader',async()=>{
  const bytes=readFileSync(new URL('../public/sample-invention.pdf',import.meta.url));
  const result=await readUserFile(new File([bytes],'example.pdf',{type:'application/pdf'}));
  assert.equal(result.ok,true,result.ok?'':result.reason);
  if(result.ok){assert.equal(result.file.format,'pdf');assert.ok(result.file.chars>100);}
});
test('uploaded DOCX preserves Chinese paragraph text',async()=>{
  const bytes=await Packer.toBuffer(new Document({sections:[{children:[new Paragraph('合成测试材料：分区流量采集。'),new Paragraph('第二步：根据流量偏差控制阀门。')]}]}));
  const result=await readUserFile(new File([new Uint8Array(bytes)],'synthetic.docx'));
  assert.equal(result.ok,true);
  if(result.ok){assert.match(result.file.text,/分区流量采集/);assert.match(result.file.text,/根据流量偏差控制阀门/);}
});
test('uploaded presentation and spreadsheet archives use their document parts',async()=>{
  const enc=new TextEncoder();
  const ppt=await writeZip([{name:'ppt/slides/slide1.xml',data:enc.encode('<p:sld><a:p><a:r><a:t>合成演示文稿主题</a:t></a:r></a:p></p:sld>')}]);
  const slides=await readUserFile(new File([ppt as BlobPart],'synthetic.pptx'));
  assert.equal(slides.ok,true);
  if(slides.ok)assert.match(slides.file.text,/合成演示文稿主题/);
  const xlsx=await writeZip([{name:'xl/worksheets/sheet1.xml',data:enc.encode('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>分区编号</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>')}]);
  const sheet=await readUserFile(new File([xlsx as BlobPart],'synthetic.xlsx'));
  assert.equal(sheet.ok,true);
  if(sheet.ok){assert.match(sheet.file.text,/分区编号/);assert.match(sheet.file.text,/42/);}
});
test('text and structured uploads retain the provided facts',async()=>{
  for(const name of ['material.txt','material.md','material.csv','material.json','material.py']) {
    const result=await readUserFile(new File(['合成测试值：42'],name));
    assert.equal(result.ok,true,name);
    if(result.ok)assert.match(result.file.text,/42/);
  }
});
test('unsupported legacy Office and empty files fail with actionable messages',async()=>{
  const legacy=await readUserFile(new File(['synthetic'],'legacy.doc'));
  assert.equal(legacy.ok,false);if(!legacy.ok)assert.match(legacy.reason,/旧格式/);
  const empty=await readUserFile(new File([],'empty.txt'));
  assert.equal(empty.ok,false);if(!empty.ok)assert.match(empty.reason,/空文件/);
});

test('image-only slides do not masquerade as successfully extracted text',async()=>{
  const bytes=writeZip([{name:'ppt/slides/slide1.xml',data:new TextEncoder().encode('<p:sld><p:pic/></p:sld>')}]);
  const result=await readUserFile(new File([bytes as BlobPart],'image-only.pptx'));
  assert.equal(result.ok,false);
  if(!result.ok)assert.match(result.reason,/没有可读取的文字/);
});

test('blank slides are skipped without renumbering readable slides',async()=>{
  const encode=(text:string)=>new TextEncoder().encode(text);
  const bytes=writeZip([
    {name:'ppt/slides/slide1.xml',data:encode('<p:sld><p:pic/></p:sld>')},
    {name:'ppt/slides/slide2.xml',data:encode('<p:sld><a:p><a:r><a:t>第二页合成证据</a:t></a:r></a:p></p:sld>')},
  ]);
  const result=await readUserFile(new File([bytes as BlobPart],'mixed.pptx'));
  assert.equal(result.ok,true);
  if(result.ok){assert.match(result.file.text,/第 2 页/);assert.doesNotMatch(result.file.text,/第 1 页/);}
});

test('UTF-16 and HTML uploads preserve text without active script content',async()=>{
  const text='合成阈值：0.75';
  const bytes=Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(text,'utf16le')]);
  const decoded=await readUserFile(new File([bytes],'utf16.txt'));
  assert.equal(decoded.ok,true);if(decoded.ok)assert.equal(decoded.file.text,text);
  const html=await readUserFile(new File(['<script>NEVER_KEEP_THIS</script><p>合成阈值：0.75</p>'],'page.html'));
  assert.equal(html.ok,true);if(html.ok){assert.match(html.file.text,/0.75/);assert.doesNotMatch(html.file.text,/NEVER_KEEP_THIS/);}
});

test('corrupt Office and unsupported binary inputs fail rather than creating materials',async()=>{
  for(const name of ['broken.docx','broken.pptx','broken.xlsx','unsupported.bin']){
    const result=await readUserFile(new File([new Uint8Array([0,255,0,42])],name));
    assert.equal(result.ok,false,name);
  }
});
