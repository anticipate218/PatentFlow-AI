import { NOTICE_VERSION } from './site-info.ts';

export const NOTICE_ENTRY_KEY = 'patentflow.notice.entry-once';
const HANDOFF_MS = 30_000;
type EntryStorage = { getItem(key: string): string | null; removeItem(key: string): void };

/** Only bridges the server notice form to its immediate redirect, never a remembered consent. */
export function consumeNoticeEntry(storage: EntryStorage, navigationType: string, now = Date.now()): boolean {
  try {
    const raw = storage.getItem(NOTICE_ENTRY_KEY);
    storage.removeItem(NOTICE_ENTRY_KEY);
    if (!raw || navigationType !== 'navigate') return false;
    const entry = JSON.parse(raw) as { version?: string; at?: number };
    return entry?.version === NOTICE_VERSION && typeof entry.at === 'number'
      && Number.isFinite(entry.at) && now >= entry.at && now - entry.at <= HANDOFF_MS;
  } catch {
    // Blocked or corrupted browser storage must show the notice, not bypass it.
    return false;
  }
}

/** This script runs only on the Worker's notice form, which still validates acknowledgement. */
export function noticeEntryScript(): string {
  return [
    '(() => {',
    'const key = ' + JSON.stringify(NOTICE_ENTRY_KEY) + ';',
    'const version = ' + JSON.stringify(NOTICE_VERSION) + ';',
    'const clear = () => { try { sessionStorage.removeItem(key); } catch {} };',
    'clear(); window.addEventListener("pageshow", clear);',
    'document.querySelector("form").addEventListener("submit", event => {',
    'const form = event.currentTarget;',
    'const ack = form.querySelector("input[name=notice]");',
    'if (!form.checkValidity() || !ack?.checked || ack.value !== version) return;',
    'try { sessionStorage.setItem(key, JSON.stringify({ version, at: Date.now() })); } catch {}',
    '}); })();',
  ].join('\n');
}
