import test from 'node:test';
import assert from 'node:assert/strict';
import type {InventionDraftState} from './model.ts';
import {draftPanelData} from './draft-panel-data.ts';

const draft:InventionDraftState={text:'# 发明名称：一种合成测试方法\n\n## 权利要求书\n1. 一种测试方法，其特征在于，读取传感数据并输出处理结果。\n2. 根据权利要求1所述的方法，其特征在于，对处理结果进行校验。\n\n## 附图说明\n图1为处理流程图。\n',score:80,at:'2026-11-05',model:'fake',revised:false,pendingMarks:0,claimCount:2,priorArt:[],checks:[{label:'测试核查',ok:false,detail:'需要核验'}],distinguishing:[],pending:['待确认传感参数']};

test('draft panels use current application content rather than legacy case fields',()=>{
  const data=draftPanelData(draft,'旧案件标题');
  assert.equal(data.app.claims.length,2);
  assert.equal(data.app.figures.length,1);
  assert.equal(data.checks[0].detail,'需要核验');
  assert.equal(data.pending[0],'待确认传感参数');
  assert.equal(data.revisions.length,0);
});

test('revised and restored draft content is reflected on every new projection',()=>{
  const revised={...draft,text:draft.text.replace('读取传感数据','读取温度数据')};
  assert.match(draftPanelData(revised,'').app.claims[0].lines.join(''),/读取温度数据/);
  assert.match(draftPanelData(draft,'').app.claims[0].lines.join(''),/读取传感数据/);
});
