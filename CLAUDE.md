# CLAUDE.md

## What this project is

Unattended invoice intake for a single Google Workspace mailbox. Invoices arrive
by email at `invoices@boom.haus` (an alias on the maintainer's personal
account). Once a day, a Google Apps Script job classifies new mail, extracts
structured data from PDF invoices with the Anthropic API, files the PDFs into
the `Accounting` shared drive under `{YYYY}/{MM}/invoices|receipts/`, appends an
append-only processing log, and escalates anything it cannot handle safely back
into the Gmail inbox plus an email digest.

**[specification.md](specification.md) is the source of truth.** Design is
closed; do not relitigate decisions recorded in §3 and §8 (runtime, two-pass
model usage, allowlist semantics, no per-vendor rules). Read the spec before
changing pipeline behaviour.

## Invariants (spec Appendix B — never violate)

1. Every destination (folder year/month, log sheet year) derives from the
   invoice **issue date**, never the run date. Never `new Date(issueDate)` —
   parse the ISO date as a string (spec §4.8).
2. The daily Gmail query is always anchored on `label:invoices-inbox`, and the
   label's presence is asserted per message before any write.
3. No unallowlisted sender's bytes ever reach Drive. The allowlist check
   precedes both model passes.
4. Model output is attacker-influenced (it reads attacker-controlled PDFs).
   Sanitize filenames and range-validate dates before anything becomes a path.
5. Allowlist read failure fails **closed** (treat everyone as unapproved).
6. Filing precedes labeling. Applying the terminal label is always the last
   action, so any earlier failure is retried on the next run.
7. The script never writes to the allowlist sheet and never deletes, archives,
   or modifies mail content — it only adds/removes its own labels, moves to
   inbox, marks unread, and sends the digest.

## Architecture

- **Runtime:** Google Apps Script (V8), TypeScript bundled by esbuild into a
  single IIFE, deployed with clasp. Target `es2019`.
- **No promises/async anywhere.** Apps Script services are synchronous
  (`UrlFetchApp`, not `fetch`). The provider interface (spec §5) is pure and
  sync; transport lives in adapters.
- **Zero runtime dependencies.** No Zod, no npm packages in the bundle.
- **Layering** (spec §6):
  - `src/pure/` — all decision logic. **Must not reference any Google global**
    (`GmailApp`, `Drive`, `DriveApp`, `SpreadsheetApp`, `Utilities`,
    `UrlFetchApp`). Enforced by ESLint `no-restricted-globals`; keep it that way.
  - `src/adapters/` — thin, dumb wrappers over Google services. No decisions.
  - `src/providers/` — pure request builders / response parsers per model
    provider.
  - `src/main.ts` — trigger entry points only; `src/run.ts` — orchestration.
- **Build gotcha:** triggers bind to global function names; the esbuild footer
  shim (`globalName: 'App'` + `function dailyRun() { return App.dailyRun(); }`)
  is what makes them visible. Ship exactly `bundle.js` + `appsscript.json`.

## Commands

```bash
npm run build          # tsc --noEmit + esbuild bundle
npm test               # vitest run (pure layer only, no mocks)
npm run push           # build + clasp push (manual, deliberate)
```

There is a **single Apps Script project** (decided 2026-08-02, superseding
spec §6 "Staging"). Which drive the code writes to is governed entirely by the
`ACCOUNTING_DRIVE_ID` Script Property — point it at the scratch shared drive
for testing and the soak week, at the real `Accounting` drive for live. No CI
deployment — deploys are manual by design (spec §6 Deployment).

## Testing policy

- Test the pure layer exhaustively with Vitest, node environment, **no mocks of
  any kind**. The test table in spec §6 maps each module to the silent
  production failure it prevents.
- Run the date tests under multiple `TZ` values (e.g. `Pacific/Kiritimati`,
  `Pacific/Midway`); results must be identical.
- Golden-file tests for provider `parse*Response` against saved raw API
  responses in `test/fixtures/`.
- **Do not unit-test adapters.** They are verified by hand from the Apps Script
  editor against the staging drive.

## Conventions and gotchas

- Gmail label names: the API uses `invoices/inbox` (slash), search queries use
  `invoices-inbox` (hyphen). Convert in exactly one helper (`pure/query.ts`);
  never hand-write a query string.
- Gmail search **canonicalizes the account's own aliases**: `to:` or
  `deliveredto:` on `invoices@boom.haus` matches the entire mailbox, so no
  query may rely on them. Ingress relies on the delivery-time filter (To
  field, literal matching); anything alias-scoped in code inspects the raw
  `Delivered-To` header instead (see PLAN.md Open item 9).
- The label state machine is **message-scoped**, not thread-scoped (decided
  2026-08-02): query with `Gmail.Users.Messages.list({q})` and mutate labels
  with `Gmail.Users.Messages.modify` (advanced Gmail service), so a new
  invoice replied into an already-processed thread still matches the daily
  query. Never use `GmailApp` thread-level search or `thread.addLabel` for
  pipeline state; `GmailApp.getMessageById` is fine for reading. Label IDs are
  resolved from names once and cached.
- Every Drive advanced-service call passes `supportsAllDrives: true`; every
  list also passes `includeItemsFromAllDrives: true`.
- Create sheets with `Drive.Files.create` (spreadsheet mimeType, parent set),
  never `SpreadsheetApp.create()` (lands in My Drive).
- Sheets writes: one `setValues` per sheet per run, grouped by target year — a
  single run can span two log sheets (spec §4.9).
- Secrets and config live in Script Properties (spec Appendix A). The Anthropic
  API key is never in the repo or `appsscript.json`.
- Sanitizers are allowlist-based, not denylist-based.

## Current status

See [PLAN.md](PLAN.md) for the implementation checklist (derived from spec §7)
and for maintainer decisions that supersede parts of the spec (single Apps
Script project, message-scoped labels, revised DRY_RUN, filter predicate,
inbox behaviour — all under "Open items" and the phase notes).

As of 2026-08-02: Phase 0 (Google-side setup) done except the Anthropic API
key (deferred to Phase 5); Phase 1.1 (scaffold) and 1.2 (deploy plumbing)
done — the do-nothing bundle is pushed and both advanced services are
verified from the editor. Next: Phase 2, the pure core.
