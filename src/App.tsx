import { DshFrame } from "./dsh-frame.tsx";
import { StoreProvider } from "./store.tsx";
import { useEffect, useState } from 'react';
import { UsageNotice } from './usage-notice.tsx';

export default function App({ noticeAcknowledged = false }: { noticeAcknowledged?: boolean }) {
  const [entered, setEntered] = useState(noticeAcknowledged);
  const [noticeOpen, setNoticeOpen] = useState(!noticeAcknowledged);
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setNoticeOpen(true);
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);
  return <>
    {!entered && <main className="notice-entry-surface"><strong>PatentFlow AI</strong><p>请先阅读免责声明与使用风险提示</p></main>}
    {entered && <div className="notice-gated-workspace" hidden={noticeOpen} inert={noticeOpen}>
      <StoreProvider><DshFrame /></StoreProvider>
    </div>}
    {noticeOpen && <UsageNotice required onClose={() => { setEntered(true); setNoticeOpen(false); }} />}
  </>;
}
