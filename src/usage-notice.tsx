import { useEffect, useRef, useState } from 'react';
import { NOTICE_ACK, NOTICE_SECTIONS, NOTICE_SUMMARY, NOTICE_TITLE, NOTICE_VERSION } from './site-info.ts';

/** Per-document acknowledgement is separate from the Worker's signed API admission. */
export function UsageNotice({ onClose, required = false }: { onClose: () => void; required?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Native cancellation must be blocked before React's delegated cancel handler runs.
    const preventNativeCancel = (event: Event) => event.preventDefault();
    dialog.setAttribute('closedby', required ? 'none' : 'closerequest');
    dialog.addEventListener('cancel', preventNativeCancel);
    dialog?.showModal();
    titleRef.current?.focus({ preventScroll: true });
    dialog.scrollTop = 0;
    return () => { dialog.removeEventListener('cancel', preventNativeCancel); dialog.close(); };
  }, [required]);
  return <dialog ref={ref} className="usage-notice" aria-labelledby="usage-notice-title" aria-describedby="usage-notice-summary" onCancel={event => { event.preventDefault(); if (!required) onClose(); }}>
    <header><div><span className="notice-eyebrow">{required ? '每次打开均需确认 · 不影响已保存的资料' : '使用前请知悉'}</span><h2 id="usage-notice-title" ref={titleRef} tabIndex={-1}>{NOTICE_TITLE}</h2></div>{!required && <button type="button" aria-label="关闭使用公告" onClick={onClose}>×</button>}</header>
    <p className="notice-summary" id="usage-notice-summary">{NOTICE_SUMMARY}</p>
    <div className="notice-sections">{NOTICE_SECTIONS.map(section => <section key={section.title}><h3>{section.title}</h3><p>{section.text}</p></section>)}</div>
    <footer>
      {required && <label className="notice-confirm"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span>{NOTICE_ACK}</span></label>}
      <small>公告版本：{NOTICE_VERSION}{required ? ' · 不希望继续使用时，可关闭本页面。' : ''}</small>
      <button className="btn primary" type="button" disabled={required && !acknowledged} onClick={() => { if (!required || acknowledged) onClose(); }}>{required ? '知悉风险并进入工作台' : '我已了解，返回工作台'}</button>
    </footer>
  </dialog>;
}
