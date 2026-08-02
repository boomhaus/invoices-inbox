# Implementation plan

Derived from [specification.md](specification.md) §7, broken into smaller
review units. Each unit is a single PR-sized change with its own acceptance
criteria; each leaves the repo green (`npm run build && npm test`). Spec step
numbers are given so nothing drifts from the source of truth.

Legend: **[code]** = reviewable as a diff. **[manual]** = human action in
Google UIs or the Apps Script editor; recorded here so it isn't skipped.

---

## Phase 0 — Google-side setup (spec Step 0) [manual, maintainer-owned]

No code. Blocks Phase 4+ but not Phases 1–3.

- [x] 0.1 Gmail filter: **To field = `invoices@boom.haus`** (NOT
      `deliveredto:` — see Open item 9) → apply label `invoices/inbox`
      **only**. Maintainer decision 2026-08-02, superseding spec §4.1: no
      "skip inbox", no "mark read" — invoices stay visible and unread in the
      inbox so they get paid; the maintainer archives manually.
      **"Never send to Spam" stays unchecked.** Search cannot preview this
      filter (alias canonicalization); verify behaviorally with a test mail
      from an outside address. *Done 2026-08-02, verified behaviorally: alias
      mail gets the label, mail to the primary address does not.*
- [x] 0.2 Create labels `invoices/inbox`, `invoices/processed`,
      `invoices/needs_action`, `invoices/other` (slashes, not hyphens).
      *Done 2026-08-02; all four confirmed visible via the Gmail API.*
- [x] 0.3 Create `Accounting/processing_allowlist` sheet (columns `domain`,
      `approved` checkbox, `vendor_name`, `notes`); seed 2–3 vendors.
      *Done 2026-08-02.*
- [x] 0.4 Record the `Accounting` shared drive ID; create a scratch shared
      drive for testing and record its ID (used by 4.1/5.4 verification and
      the soak week by pointing `ACCOUNTING_DRIVE_ID` at it).
      Recorded 2026-08-02: `Accounting` = `0ALFm4qL4pig9Uk9PVA`,
      `Accounting-test` (scratch) = `0AGjgAN8kFLviUk9PVA`.
- [ ] 0.5 Issue Anthropic API key with a spend limit. *Deferred by the
      maintainer until Phase 5, where the first model call happens.*
- [x] 0.6 Create the single Apps Script project (decided 2026-08-02: one
      production project, no separate staging project — supersedes spec §6
      "Staging" and Step 1). *Done 2026-08-02 via `clasp create-script`;
      script ID `16E19i3IP8IMietu85YfVbX2JBjvjVQwTeKE3RqtwnBRfaJkB1-Sge_Lm`,
      recorded in `.clasp.json`.*
- [x] 0.7 (discovered requirement) The Workspace admin **Drive SDK** toggle
      (Admin console → Apps → Google Workspace → Drive and Docs → Features
      and Applications) must be ON — it was off for boom.haus and blocked all
      API access to Drive with "The domain administrators have disabled Drive
      apps". Enabled 2026-08-02. If it is ever switched off again, every
      nightly run fails with that exact error.

---

## Phase 1 — Toolchain (spec Step 1)

### 1.1 Local scaffold [code] — DONE 2026-08-02
`package.json`, `tsconfig.json` (target `es2019`,
`@types/google-apps-script`), esbuild config with `globalName: 'App'` and the
global-function footer shim, Vitest with one trivial test, ESLint with
`no-restricted-globals` scoped to `src/pure/`, `src/main.ts` exporting a
`dailyRun` that logs one line.

**Accept:** `npm run build` emits a single IIFE bundle; the lint rule fails a
deliberate `GmailApp` reference inside `src/pure/`; `npm test` passes.

*All three acceptance criteria verified 2026-08-02. One layout deviation: the
build script is plain-JS `tools/build.mjs` instead of the spec's
`tools/esbuild.config.ts` (running a TS build script would need an extra
tool). Toolchain: TypeScript 5.9, esbuild 0.28, Vitest 4, ESLint 9 flat
config, @google/clasp 3.3.*

### 1.2 Deploy plumbing [code + manual] — DONE 2026-08-02
`appsscript.json` (`timeZone: "Europe/Prague"`, explicit `oauthScopes`, the
advanced **Drive and Gmail** services), a single `.clasp.json`, one
`push` npm script. Single Apps Script project — which drive and mailbox
behaviour the code targets is governed by Script Properties
(`ACCOUNTING_DRIVE_ID`, `DRY_RUN`), not by project switching.

**Accept (manual, in the Apps Script editor):** `dailyRun` is visible and
runnable after `npm run push` (proves the footer shim); one-line
`Drive.Drives.list()` and `Gmail.Users.Labels.list('me')` calls succeed
(proves both advanced services are enabled in the editor UI, not just
declared — spec Step 1 risk note).

*Verified 2026-08-02: maintainer ran the temporary `verifySetup` entry point
from the editor after granting the OAuth consent — it listed both shared
drives (`Accounting`, `Accounting-test`) and all four `invoices/…` labels.
Along the way the Drive SDK admin toggle had to be enabled (see 0.7).
`verifySetup` stays in `src/main.ts` until the real adapters replace it.*

### 1.3 CI for tests only [code] — ON HOLD
GitHub Actions: `tsc --noEmit && vitest run`, with the date suite repeated
under `TZ=Pacific/Kiritimati` and `TZ=Pacific/Midway`. No CI deployment (spec
§6). *On hold pending a GitHub remote for the repo; until then the same
checks run locally (`npm run push` chains build + lint, `npm test` for the
suite, TZ-matrix runs via `TZ=… npm test`).*

---

## Phase 2 — Pure core (spec Step 2)

Three PRs instead of one so each module's test table is reviewable on its own.
No Google globals anywhere in this phase.

### 2.1 `pure/naming.ts` + `pure/dates.ts` [code]
Filename sanitization (allowlist-based), prefix construction, length cap
truncating only the original-filename segment, collision suffix `_2`, `_3`, …
inserted before the extension; issue-date string parsing to
`{year, month}`, sane-window validation (>24 months past / >1 month future
rejected).

**Accept:** the named cases in spec Step 2 — `../../../etc/passwd` becomes
safe; 400-char name truncates only the original segment; Czech diacritics
survive; `2026-08-01` → `{year:'2026', month:'08'}` under any `TZ`;
`2019-01-01` and `2030-01-01` rejected. `new Date(` does not appear anywhere
near `issueDate`.

### 2.2 `pure/domains.ts` + `pure/query.ts` + `pure/routing.ts` [code]
Domain normalization (lowercase, trim, strip `@`/`www.`), exact-match lookup,
malformed-entry detection (no dot ⇒ report); daily-query builder with the
slash↔hyphen label-name conversion in exactly one helper; role → target leaf
routing.

**Accept:** `X.COM`, ` x.com `, `@x.com`, `www.x.com` all match `x.com`;
`x.co` does not; the built query always contains the `invoices-inbox` anchor
and changes when the terminal set changes; `receipt` never routes to the
`invoices/` leaf.

### 2.3 `pure/validate.ts` + `pure/grouping.ts` [code]
`InvoiceData` structural validation (hand-rolled, ~40 lines, no Zod) plus
semantic checks; grouping of log rows into `Map<year, rows[]>`.

**Accept:** prose instead of JSON throws with a useful message; missing
`issueDate` yields a fallback signal, not a crash; rows dated 2026-12 and
2027-01 in one run produce two groups.

---

## Phase 3 — Providers (spec Steps 5–6, pure halves only)

### 3.1 Provider types + classify (Pass A) [code]
`providers/types.ts` (including the `MessageMetadata` shape the spec references
but does not define — see Open items), `anthropic.ts`
`buildClassifyRequest` / `parseClassifyResponse`, `registry.ts`. Golden-file
fixtures of raw API responses.

**Accept:** fixtures cover: the X (Twitter) two-attachment email yielding one
`invoice` + one `receipt` role; a not-invoice; a malformed model reply that
throws. Body text is truncated before request construction. No PDF bytes in
Pass A requests.

### 3.2 Extract (Pass B) [code]
`buildExtractRequest` / `parseExtractResponse` with PDF as a base64 document
block. Golden fixtures, including a response with nulls and a prose response.

**Accept:** parser normalizes to `InvoiceData` exactly; provider id is
recorded; fixtures round-trip.

---

## Phase 4 — Adapters (spec Step 3)

### 4.1 `adapters/` + `config.ts` [code + manual verification]
`gmail.ts` (message-level query and label mutations via the advanced Gmail
service, label name → ID resolution cached, `GmailApp.getMessageById` for
reading), `drive.ts` (`ensurePath` with folder-mimeType filter, Script
Properties ID cache), `sheets.ts`, `http.ts` (retry ~1s/4s/16s,
`muteHttpExceptions`), typed `config.ts`. No unit tests — verified by hand
against the scratch drive (spec testing policy).

**Accept (manual):** `ensurePath('2026','08','invoices')` creates the tree and
returns an ID; second call hits the cache; a sheet in the year folder does not
confuse month resolution; every Drive call passes `supportsAllDrives: true`
(and lists add `includeItemsFromAllDrives: true`); labeling a single message
in a multi-message thread does not label its siblings.

---

## Phase 5 — Pipeline, one behaviour per PR

Destructive capability arrives late (5.4) and lands in the scratch drive
first (`ACCOUNTING_DRIVE_ID` Script Property), then behind the DRY_RUN soak.

### 5.1 Allowlist gate + labeling (spec Step 4) [code]
Fail-closed allowlist read, daily query with batch cap 25, per-message
`invoices/inbox` assertion (invariant 2) **before any action**, unknown
senders → `needs_action` + inbox + unread, known senders logged to console
only. Manual trigger only.

**Accept:** run against the real mailbox; unknown senders surface in the
inbox; removing the label re-queues a thread; renaming the allowlist sheet
treats everyone as unknown without crashing.

### 5.2 Pass A wiring + circuit breaker (spec Step 5) [code]
`not_invoice` → `other`; invoice without PDF → `needs_action`; invoice with
PDF logs roles and stops. In-run retry (in `http.ts`) plus the >50%-failure
circuit breaker that aborts the run, labels nothing, and reports.

**Accept:** spec Step 5 acceptance list, including the forced-500 abort.

### 5.3 Pass B wiring + validation chain (spec Step 6) [code]
Size ceiling and password-protection detection before the API call; then
structural validation → semantic date window → sanitization; log the target
path it *would* use. Includes the deliberate prompt-injection fixture: a PDF
whose text instructs the model to alter output must not change the target
path.

### 5.4 Drive filing (spec Step 7) [code] — first destructive step
Collision check (listing filtered to non-folders), lazy leaf creation,
receipts filed under the paired invoice's issue-date month, standalone-receipt
fallback (own date, then email timestamp, flagged), `supporting` not filed.
Filing strictly precedes labeling.

**Accept:** `ACCOUNTING_DRIVE_ID` pointed at the scratch drive only; X email
→ one file in `invoices/`, one in `receipts/`, same month; duplicate filename
→ `_2`; December invoice processed in January lands in `2026/12/`.

### 5.5 Processing log + dedupe (spec Step 8) [code]
`ensureYearSheet` via `Drive.Files.create`, header row frozen, ID cached;
rows grouped by target year, one `setValues` per sheet; dedupe set
(`gmail_message_id + attachment_filename`, current + previous year) loaded at
run start; `filed=false` rows for PDF-bearing `not_invoice` messages.

**Accept:** synthetic 2026-12/2027-01 batch writes two sheets, creating the
2027 sheet mid-run; simulated crash between Drive write and label write does
not double-file; message ID alone is proven insufficient via the X email.

### 5.6 Digest + heartbeat (spec Step 9) [code]
Two-section actionable digest (unknown senders / processing problems), sent
only when non-empty, to the primary address, with Gmail thread links and
already-filed markers. Weekly heartbeat with all four checks (counts, spam
check, filter-leak check, 14-day aging check). Top-level try/catch whose final
act is a failure-tolerant digest send. Second time trigger for the heartbeat.

**Accept:** spec Step 9 list — digest does not acquire `invoices/inbox`;
planted spam is found; aged `needs_action` thread is named.

---

## Phase 6 — Go live (spec Steps 10–11)

- [ ] 6.1 [manual] Soak week, seven consecutive days against the real mailbox
      with `ACCOUNTING_DRIVE_ID` pointed at the scratch drive and
      `DRY_RUN=true` under the **revised semantics** (decided 2026-08-02,
      supersedes spec §6/Appendix A): files and log rows ARE written to the
      configured drive so real outputs can be reviewed; the mailbox is left
      untouched — no labels, no inbox moves, no unread marks; the digest
      sends with a `[DRY RUN]` subject prefix. The log dedupe set (5.5) is
      what prevents the unlabeled messages from re-filing duplicates on each
      successive soak day.
- [ ] 6.2 [manual] Flip `ACCOUNTING_DRIVE_ID` to the real `Accounting` drive,
      `DRY_RUN=false`; install the daily time trigger (fires within an hour
      window, not at an exact time). Spot-check the first live week by hand.
- [ ] 6.3 [manual, before December] Year-rollover rehearsal: forced future
      issue date must create `2027/`, `2027/01/invoices/`, and
      `processing_log_2027` with no manual setup; delete the artifacts.

---

## Open items (gaps found reviewing the spec — resolve before the phase that needs them)

1. **`MessageMetadata` is referenced in §5 but never defined.** Proposed shape
   (needed by 3.1): `{ subject, fromHeader, dateIso, bodyTextTruncated,
   attachments: { filename, mimeType, sizeBytes }[] }`.
2. **Thread-scoped labels can silently drop a second invoice.** A vendor
   replying with a new invoice into an already-`processed` thread would be
   excluded by the daily query forever under `GmailApp`, whose API only
   exposes thread-level labels and search. **Resolved (2026-08-02): make the
   label state machine message-scoped via the Advanced Gmail service.**
   Labels in Gmail are natively per-message; `Gmail.Users.Messages.list({q})`
   evaluates the daily query per message and `Gmail.Users.Messages.modify`
   applies labels (including `INBOX`/`UNREAD`) per message, so a new reply in
   an old thread matches the query on its own and the edge case disappears
   structurally — no extra heartbeat check needed. `GmailApp.getMessageById`
   is still used for reading headers/body/attachments. Consequences for the
   plan: enable the advanced Gmail service alongside Drive (1.2), resolve and
   cache label name → label ID once via `Gmail.Users.Labels.list`
   (`adapters/gmail.ts`, 4.1), and the §4.12 per-message label assertion
   checks the message's own `labelIds`.
3. **`DRY_RUN` semantics revised (2026-08-02), superseding spec §6 "Dry-run
   mode" and Appendix A.** Maintainer decision: dry run SHOULD write files.
   Adopted semantics: the full pipeline runs and writes files and log rows to
   whatever drive Script Properties point at (the scratch drive during the
   soak), but never mutates the mailbox — no labels, no inbox moves, no
   unread marks. Digest sends with a `[DRY RUN]` subject prefix. Duplicate
   prevention across soak days comes from the log dedupe set, not labels.
   `specification.md` still carries the old no-writes wording and should be
   amended by the maintainer.
4. **Six-minute ceiling vs worst-case retries.** 25 messages × two passes ×
   up to ~21s of backoff each can exceed the Apps Script limit. Proposed: an
   elapsed-time guard that stops starting new messages after ~4.5 minutes;
   safe because unlabeled leftovers retry the next day (invariant 6).
5. **Model IDs for `PROVIDER_ID`.** **Resolved (2026-08-02):
   `claude-sonnet-5` for both passes** (recommendation adopted). Rationale:
   §2 explicitly rules out cost as a design input at this volume, extraction
   accuracy on `issueDate` decides where files land, and a single model id
   keeps the registry trivial. The provider registry still allows adding a
   Haiku variant later for the deferred eval harness (spec §8).
6. **Pass B size ceiling number.** Anthropic document blocks cap at 100 pages /
   ~32MB request; UrlFetchApp payloads cap at 50MB and base64 inflates by ⅓.
   Proposed ceiling: 20MB raw PDF.
7. **Password-protected PDF detection method** (before the API call, spec
   §4.11): check the raw bytes for an `/Encrypt` trailer entry — cheap and
   sufficient for routing to `needs_action`.
8. **`oauthScopes` list** for `appsscript.json` (needed by 1.2):
   `https://mail.google.com/` (GmailApp), `…/auth/drive`,
   `…/auth/spreadsheets`, `…/auth/script.external_request`.
9. **Gmail search canonicalizes the account's own aliases — spec §2/§4.1
   premise superseded (verified empirically 2026-08-02).** Alias mail DOES
   carry `Delivered-To: invoices@boom.haus` (confirmed from raw headers), but
   search-time `deliveredto:invoices@…` and `to:invoices@…` both resolve the
   alias to "this mailbox" and match ALL mail (a nonsense address matches
   nothing, proving the operator itself works). Consequences:
   - The ingress filter uses the **To field** with the alias address —
     delivery-time filter matching is literal, per Google's documented
     alias-sorting approach. Verified behaviorally, never via search preview.
   - Known loss: mail with the alias only in Bcc misses the filter (header
     lacks the address). Caught by the reworked leak check below.
   - Heartbeat checks 2 and 3 (spam check, filter-leak check) cannot use
     alias-scoped search queries. Rework (lands in 5.6): list candidates with
     a broad query (`in:spam newer_than:8d` / `has:attachment filename:pdf
     newer_than:8d -label:invoices-inbox`) via the advanced Gmail service,
     then filter **in code on the raw `Delivered-To` header**, which is the
     reliable predicate search cannot express. Volume makes this cheap.
   - No digest feedback loop remains impossible: the digest goes To the
     primary address, which never matches the alias To-field filter.
