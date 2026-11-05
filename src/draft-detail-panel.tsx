import { useMemo } from 'react';
import type { InventionDraftState } from './model.ts';
import { draftPanelData } from './draft-panel-data.ts';

export function DraftDetailPanel({draft,title,pane}:{draft:InventionDraftState;title:string;pane:string}) {
  const data=useMemo(()=>draftPanelData(draft,title),[draft,title]);
  if(pane==='claims') return <section aria-label="当前申请稿权利要求">
    <p>当前申请稿 · {data.app.claims.length} 项权利要求</p>
    {data.app.claims.map(claim=><p key={claim.no} style={{whiteSpace:'pre-wrap'}}><strong>{claim.no}. </strong>{claim.lines.join('\n')}</p>)}
    {!data.app.claims.length&&<p>当前申请稿没有可识别的权利要求，请补充后再导出。</p>}
  </section>;
  if(pane==='figures') return <section aria-label="当前申请稿附图">
    <p>当前申请稿 · {data.app.figures.length} 幅附图，{data.figures.length} 幅有绘图数据</p>
    {data.app.figures.map(figure=>{
      const rendered=data.figures.find(item=>item.no===figure.no);
      return <figure key={figure.no} style={{margin:'16px 0'}}>
        <figcaption>{figure.caption}</figcaption>
        {rendered?<img loading="lazy" style={{width:'100%',height:'auto',background:'white'}} alt={'图'+figure.no+' '+figure.caption} src={'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(rendered.svg)}/>:<p>此图尚缺绘图数据，请修改后重新核查。</p>}
      </figure>;
    })}
    {!data.app.figures.length&&<p>当前申请稿未列出附图。</p>}
  </section>;
  if(pane==='review') return <section aria-label="当前申请稿审核">
    <p>当前申请稿自检 {draft.score} 分；形式核查 {data.report.errors} 项需修改、{data.report.warnings} 项需注意。</p>
    {data.checks.map((check,index)=><p key={'draft-'+index}><strong>{check.label}：</strong>{check.detail}</p>)}
    {data.report.checks.filter(check=>check.level!=='ok').map(check=><p key={check.id}><strong>{check.label}：</strong>{check.detail}</p>)}
    {data.pending.length>0&&<><h3>需要确认的事项</h3><ul>{data.pending.map((item,index)=><li key={index}>{item}</li>)}</ul></>}
    {draft.mathReview?.notes?.length?<><h3>公式与参数审阅</h3>{draft.mathReview.notes.map((note,index)=><p key={index}>{note}</p>)}</>:null}
    <p className="fine">自动检查不替代技术事实核验或专业审阅。</p>
  </section>;
  if(pane==='chart') return <section aria-label="当前申请稿查新">
    <p>当前申请稿的检索线索与区别技术特征，不是官方查新结论。</p>
    {data.priorArt.length?data.priorArt.map(item=><article key={item.pn}><strong>{item.pn} · {item.title}</strong><p>{item.note}</p></article>):<p>本稿没有可比对的专利文献，不能据此认定具有新颖性或创造性。</p>}
    {(draft.distinguishing ?? []).map((item,index)=><p key={index}><strong>{item.feature}</strong><br/>{item.problem}<br/>{item.effect}</p>)}
  </section>;
  if(pane==='diff') return <section aria-label="当前申请稿修改记录">
    {data.revisions.length?data.revisions.map((revision,index)=><article key={revision.at+'-'+index}>
      <h3>第 {index+1} 次修改</h3><p>{revision.summary}</p><p>{revision.instruction}</p>
      {revision.applied.map((patch,i)=><details key={i}><summary>{patch.reason||'查看定点修改'}</summary><p>修改前</p><pre>{patch.find}</pre><p>修改后</p><pre>{patch.replace}</pre></details>)}
    </article>):<p>当前版本没有未撤销的修改记录。修改后可在这里核对实际替换内容。</p>}
  </section>;
  return null;
}
