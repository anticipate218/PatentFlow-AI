import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { consumeNoticeEntry, NOTICE_ENTRY_KEY, noticeEntryScript } from './notice-entry.ts';
import { NOTICE_ACK, NOTICE_SECTIONS, NOTICE_TITLE, NOTICE_VERSION } from './site-info.ts';

const now = 1_800_000_000_000;
function storage(initial?: string) {
  const values = new Map<string, string>(initial ? [[NOTICE_ENTRY_KEY, initial]] : []);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}
const marker = (at = now, version = NOTICE_VERSION) => JSON.stringify({ at, version });

test('the published notice document matches the UI wording and current version', () => {
  const document = readFileSync(new URL('../docs/usage-notice.md', import.meta.url), 'utf8');
  for (const text of [NOTICE_ACK, NOTICE_TITLE, NOTICE_VERSION, ...NOTICE_SECTIONS.flatMap(section => [section.title, section.text])]) {
    assert.ok(document.includes(text));
  }
});

test('opening without a just-submitted entry form requires notice acknowledgement', () => {
  assert.equal(consumeNoticeEntry(storage(), 'navigate', now), false);
});

test('immediate form redirect avoids a duplicate prompt, but never a subsequent opening', () => {
  const saved = storage(marker());
  assert.equal(consumeNoticeEntry(saved, 'navigate', now), true);
  assert.equal(saved.getItem(NOTICE_ENTRY_KEY), null);
  assert.equal(consumeNoticeEntry(saved, 'navigate', now), false);
});

for (const navigation of ['reload', 'back_forward', '']) {
  test('a form marker cannot skip acknowledgement for navigation type: ' + navigation, () => {
    const saved = storage(marker());
    assert.equal(consumeNoticeEntry(saved, navigation, now), false);
    assert.equal(saved.getItem(NOTICE_ENTRY_KEY), null);
  });
}

for (const value of ['not-json', 'null', 'true', '{}', marker(now - 30001), marker(now + 1), marker(now, 'old-version')]) {
  test('invalid or expired handoff is discarded: ' + value, () => {
    const saved = storage(value);
    assert.equal(consumeNoticeEntry(saved, 'navigate', now), false);
    assert.equal(saved.getItem(NOTICE_ENTRY_KEY), null);
  });
}

test('storage failures fail closed rather than suppressing the notice', () => {
  for (const method of ['getItem', 'removeItem'] as const) {
    const saved = storage(marker());
    saved[method] = () => { throw new Error('storage blocked'); };
    assert.equal(consumeNoticeEntry(saved, 'navigate', now), false);
  }
});

test('server entry script only hands off explicit valid form acknowledgement', () => {
  const saved = storage(marker(now, 'old-version'));
  const listeners = new Map<string, (event?: unknown) => void>();
  const checkbox = { checked: false, value: NOTICE_VERSION };
  let valid = true;
  const form = {
    checkValidity: () => valid,
    querySelector: () => checkbox,
    addEventListener: (type: string, listener: (event?: unknown) => void) => listeners.set(type, listener),
  };
  runInNewContext(noticeEntryScript(), {
    sessionStorage: saved,
    document: { querySelector: () => form },
    window: { addEventListener: (type: string, listener: () => void) => listeners.set(type, listener) },
    Date: { now: () => now },
  });
  assert.equal(saved.getItem(NOTICE_ENTRY_KEY), null);
  const submit = () => listeners.get('submit')!({ currentTarget: form });
  submit(); assert.equal(saved.getItem(NOTICE_ENTRY_KEY), null);
  checkbox.checked = true; valid = false;
  submit(); assert.equal(saved.getItem(NOTICE_ENTRY_KEY), null);
  valid = true; checkbox.value = 'old-version';
  submit(); assert.equal(saved.getItem(NOTICE_ENTRY_KEY), null);
  checkbox.value = NOTICE_VERSION;
  submit(); assert.equal(consumeNoticeEntry(saved, 'navigate', now), true);
  submit(); listeners.get('pageshow')!();
  assert.equal(saved.getItem(NOTICE_ENTRY_KEY), null);
});
