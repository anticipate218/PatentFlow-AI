import { useEffect, useRef, useState } from 'react';
import { Glyph } from './glyph.tsx';
import { createTrafficClient } from './site-traffic-data.ts';
import type { TrafficSnapshot } from './site-traffic-data.ts';

let client: ReturnType<typeof createTrafficClient> | undefined;
function trafficClient() {
  if (!client) {
    const eventId = globalThis.crypto?.randomUUID?.() ?? '';
    client = createTrafficClient(fetch, eventId, !eventId || navigator.doNotTrack === '1'
      || (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true);
  }
  return client;
}
const number = (value?: number) => value === undefined ? '—' : value.toLocaleString('zh-CN');

export function SiteTrafficBadge() {
  const [data, setData] = useState<TrafficSnapshot>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => trafficClient().record()).then(value => { if (alive) setData(value); }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, []);
  async function refresh() {
    setBusy(true);
    try { setData(await (data ? trafficClient().refresh() : trafficClient().record())); setError(false); }
    catch { setError(true); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" className="dsh-top-btn traffic-badge" onClick={() => setOpen(true)} aria-label="查看站点浏览量与访客统计" title="站点累计浏览量和匿名会话访客数；点击查看详情">
      <Glyph name="chart" /><span className="traffic-preview">浏览 <b>{number(data?.total.views)}</b> · 访客 <b>{number(data?.total.visitors)}</b></span>
    </button>
    {open && <TrafficDialog data={data} error={error} busy={busy} onRefresh={() => void refresh()} onClose={() => setOpen(false)} />}
  </>;
}

function TrafficDialog({ data, error, busy, onRefresh, onClose }: { data?: TrafficSnapshot; error: boolean; busy: boolean; onRefresh: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  const started = data?.startedAt ? new Date(data.startedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '本次功能上线';
  return <dialog ref={ref} className="usage-notice traffic-dialog" aria-labelledby="traffic-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><span className="notice-eyebrow">真实累计 · 北京时间</span><h2 id="traffic-title">站点访问统计</h2></div><button type="button" aria-label="关闭访问统计" onClick={onClose}>×</button></header>
    <div className="traffic-grid">
      {[['累计浏览 PV', data?.total.views], ['累计访客 UV', data?.total.visitors], ['今日浏览 PV', data?.today.views], ['今日访客 UV', data?.today.visitors]].map(([label, value]) => <section key={label}><span>{label}</span><strong>{number(value as number | undefined)}</strong></section>)}
    </div>
    <p className="traffic-status" role="status">{error ? '统计暂不可用，不影响生成和下载；已有数字可能不是最新值。' : data ? '统计自 ' + started + ' 开始，今日日期：' + data.today.day : '正在读取访问统计…'}</p>
    <div className="notice-sections"><section><h3>这些数字如何计算？</h3><p>确认声明后进入工作台计一次浏览；新开或刷新页面再次确认后计一次。站内切换、刷新本面板和请求重试不会重复计数。访客按现有匿名会话去重，并非真实人数；会话过期、清除 Cookie 或更换浏览器会重新计为访客。今日数据按北京时间零点分日。</p></section><section><h3>只做必要的访问统计</h3><p>仅保存匿名会话的不可逆摘要和计数，不保存 IP、浏览网址、上传材料或模型密钥；尊重浏览器 DNT / GPC 隐私信号。没有回填上线前的历史数据，测试访问也可能计入。</p></section></div>
    <footer><small>刷新本面板不会增加浏览量</small><button type="button" className="btn primary" disabled={busy} onClick={onRefresh}>{busy ? '正在刷新…' : '刷新统计'}</button></footer>
  </dialog>;
}
