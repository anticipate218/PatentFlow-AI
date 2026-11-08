import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { consumeNoticeEntry } from './notice-entry.ts'

// Consume once outside React initializers: StrictMode may run initializers twice.
let noticeAcknowledged = false
try {
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  noticeAcknowledged = consumeNoticeEntry(sessionStorage, navigation?.type ?? '')
} catch { /* Unavailable browser storage still requires an explicit acknowledgement. */ }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App noticeAcknowledged={noticeAcknowledged} />
  </StrictMode>,
)
