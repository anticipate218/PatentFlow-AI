import test from 'node:test';
import assert from 'node:assert/strict';
import { createTopic } from './skill-turn.ts';
import { runAutoPatent } from './auto-flow.ts';
import { runDraftTurn } from './draft-run.ts';
import { NOVELTY_MATERIAL_NAME } from './novelty-check.ts';

const topic = '面向温室灌溉管道的压力差诊断与分区补偿方法及系统';
const request = '沿用刚才上传的参考论文。选择主题：' + topic + '。请一键生成全套文件，不需要追问。';
const reference = {name:'reference-paper-001.pdf',kind:'pdf' as const,text:'参考论文描述的是原有方法，不是用户选择的新方案。'.repeat(10)};

test('selected topic in a follow-up instruction is extracted instead of the attachment name', () => {
  assert.equal(createTopic(request), topic);
  assert.equal(createTopic('选定题目：' + topic + '。请生成。'), topic);
  assert.equal(createTopic('帮我生成完整发明专利申请文件'), '');
});

for (const staleReport of [false, true]) {
  test('reference-based auto generation searches the selected topic' + (staleReport ? ' and refreshes an unrelated prior report' : ''), async () => {
    const abort = new AbortController();
    const queries: string[] = [];
    const materials = staleReport ? [reference,{name:NOVELTY_MATERIAL_NAME,kind:'text' as const,text:'旧查新主题：reference-paper-001'}] : [reference];
    const outcome = await runAutoPatent({caseId:'qa',userText:request,materials,dispatch:()=>{},signal:abort.signal}, {
      ask: async () => {throw new Error('Topic selection must not replace the user selection');},
      draft: {ask:async()=>{throw new Error('Stop before drafting');},search:async query=>{queries.push(query);abort.abort();return {ok:true,status:200,detail:'synthetic',results:[]};}},
    });
    assert.equal(outcome.stage,'stopped');
    assert.ok(queries.length > 0);
    assert.ok(queries[0].includes('温室灌溉'));
    assert.ok(!queries[0].includes('reference-paper'));
  });
}

test('direct drafting also prioritizes the current topic over a reference filename', async () => {
  const abort = new AbortController();
  const queries: string[] = [];
  await runDraftTurn({caseId:'qa',userText:request,materials:[reference],dispatch:()=>{},signal:abort.signal}, {
    ask:async()=>{throw new Error('Stop before drafting');},
    search:async query=>{queries.push(query);abort.abort();return {ok:true,status:200,detail:'synthetic',results:[]};},
  });
  assert.ok(queries[0].includes('温室灌溉'));
  assert.ok(!queries[0].includes('reference-paper'));
});
