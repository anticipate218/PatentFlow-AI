import test from 'node:test';
import assert from 'node:assert/strict';
import {reduce,seed} from './model.ts';

const material=(name:string,text:string)=>({name,text,kind:'text' as const});
const initial=()=>{
  const state=reduce(seed(),{type:'create-case',id:'qa-report',title:'合成案例',text:'',fileName:'',materials:[material('reference.txt','用户原始证据'),material('查新对比报告.md','旧报告一'),material('查新对比报告.md','旧报告二')]});
  return {...state,cases:state.cases.map(item=>item.id==='qa-report'?{...item,materials:item.materials.map(file=>({...file,generated:file.name==='查新对比报告.md'}))}:item)};
};

test('generated reports replace earlier versions without duplicating model context',()=>{
  const state=reduce(initial(),{type:'attach-materials',caseId:'qa-report',replaceNamed:true,materials:[material('查新对比报告.md','最新报告')]});
  const item=state.cases.find(x=>x.id==='qa-report')!;
  assert.equal(item.materials.filter(x=>x.name==='查新对比报告.md').length,1);
  assert.ok(item.materialText.includes('最新报告'));
  assert.ok(item.materialText.includes('用户原始证据'));
  assert.ok(!item.materialText.includes('旧报告'));
});

test('ordinary same-name uploads are retained rather than overwritten',()=>{
  const state=reduce(initial(),{type:'attach-materials',caseId:'qa-report',materials:[material('reference.txt','用户另一份证据')]});
  assert.equal(state.cases.find(x=>x.id==='qa-report')!.materials.filter(x=>x.name==='reference.txt').length,2);
});

test('an empty generated report does not erase the prior report',()=>{
  const state=reduce(initial(),{type:'attach-materials',caseId:'qa-report',replaceNamed:true,materials:[material('查新对比报告.md',' ')]});
  assert.ok(state.cases.find(x=>x.id==='qa-report')!.materialText.includes('旧报告'));
});

test('a user-uploaded report with the same filename is not overwritten',()=>{
  const original=reduce(seed(),{type:'create-case',id:'qa-report',title:'合成案例',text:'',fileName:'',materials:[material('查新对比报告.md','用户上传报告')]});
  const state=reduce(original,{type:'attach-materials',caseId:'qa-report',replaceNamed:true,materials:[material('查新对比报告.md','系统生成报告')]});
  const files=state.cases.find(x=>x.id==='qa-report')!.materials;
  assert.equal(files.length,2);
  assert.ok(files.some(x=>x.text==='用户上传报告'&&!x.generated));
  assert.ok(files.some(x=>x.text==='系统生成报告'&&x.generated));
});
