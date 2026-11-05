import type { InventionDraftState } from './model.ts';
import { formalCheck, parseApplication } from './cnipa-format.ts';
import { drawableFigures } from './figure-assets.ts';

/** The same current draft is authoritative for both panels and exported documents. */
export function draftPanelData(draft: InventionDraftState, fallbackTitle: string) {
  const app = parseApplication(draft.text, fallbackTitle);
  const report = formalCheck(app);
  return {
    app,
    report,
    figures: drawableFigures(app),
    checks: (draft.checks ?? []).filter(check => !check.ok),
    pending: draft.pending ?? [],
    priorArt: draft.priorArt ?? [],
    revisions: draft.revisions ?? [],
  };
}
