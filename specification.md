# Invoice Intake Automation

Specification and implementation plan.

Status: design closed, implementation not started.
Owner: single maintainer.
Last updated: 2026-08-02.

---

## 1. Purpose

Invoices for the company arrive by email at `invoices@boom.haus`. They currently
require manual download and manual filing into a shared Drive. This system does
that unattended, once per day, and escalates to a human only when it cannot
proceed safely.

### Success criteria

1. A recognized vendor's PDF invoice is filed into the correct month folder with
   zero human action.
2. Anything the system cannot handle safely is visible in the Gmail inbox and in
   a daily digest, never silently dropped.
3. A missing invoice is detectable after the fact from a log, without searching
   the mailbox.
4. Nothing untrusted is written to the accounting Drive.

### Explicit non-goals

- Portal scraping. Vendors that email a "view your invoice" link stay manual.
- Accounting logic. No VAT calculation, no reconciliation, no exports.
- Multi-user support. One mailbox, one maintainer.
- Real-time processing. Daily is sufficient.

---

## 2. Context and constraints

| Fact | Consequence |
| --- | --- |
| `invoices@boom.haus` is a Workspace alias on the maintainer's own user account | Script authorizes against the entire personal mailbox. Containment is code discipline only. |
| Mail to the alias carries `Delivered-To: invoices@boom.haus` (verified from real headers) | `deliveredto:` is a reliable filter predicate. |
| Volume: single to low double digits of invoices per month | Per-invoice cost is irrelevant. Optimize for correctness and low maintenance, never for throughput or spend. |
| Existing mailbox history is low double digits | No backfill mode needed. |
| Company is not a VAT payer | Month bucketing keys on invoice issue date, not DUZP. |
| Destination `Accounting` shared drive already exists | Resolve its ID once, cache it. |
| Emails are retained indefinitely | Script labels only. It never archives, deletes, or modifies message content. |

---

## 3. Architecture decisions

Recorded with rationale so they are not relitigated.

### 3.1 Runtime: Google Apps Script

Mailbox and destination are both Google. Apps Script removes the entire auth
problem: no OAuth refresh loop, no service account, no host to keep alive, no
secrets beyond one API key.

Rejected:

- **Self-hosted script plus cron.** Introduces a Gmail OAuth token refresh loop
  and a machine that must be awake. All cost, no benefit.
- **n8n / Zapier / Make.** A vendor and a subscription to babysit a job of a few
  hundred lines.
- **Cloud Run with a service account.** Requires domain-wide delegation, a
  Workspace-admin grant giving a service principal access to all users' mail.
  Wrong tool by an order of magnitude.

### 3.2 Language: TypeScript, bundled with esbuild, deployed with clasp

The codebase is string handling, date parsing, and validation of untrusted model
output into filesystem paths. That is the bug class a type system catches.

clasp's own TypeScript support is a legacy path with no bundling and no
dependency support. esbuild first, then push the bundle.

### 3.3 Two-pass model usage

Pass A classifies a message from metadata and body text. Pass B extracts
structured data from PDF bytes, and runs only on attachments Pass A marked as
invoices.

An attachment-presence filter cannot serve as the gate: it lets through signed
contracts and shipping labels, and it excludes portal-link invoices that have no
attachment at all.

### 3.4 Allowlist gates filing, not notification

Mail from an unrecognized sender domain is never written to Drive. It does not
even reach Pass A.

This is the only thing preventing an arbitrary sender from placing a PDF into the
accounting Drive, since anyone can email the alias. The cost is a one-day delay
per new vendor, irrelevant for monthly billing.

### 3.5 Allowlist is read-only to the script

The script reads the allowlist sheet and never writes to it. New domains are
added by hand from the digest.

Consequence: no `last_seen` tracking, so dormant vendors are not automatically
visible. Accepted.

### 3.6 No per-vendor attachment rules

Pass A decides attachment roles on every run from filenames and MIME types.

Rejected: caching per-vendor filename regexes. That is configuration that rots
silently. A vendor changes their naming, the rule stops matching, nothing errors.

Consequence: classification is nondeterministic in principle. In practice a
message is processed exactly once and receives a terminal label, so there is no
second run to disagree with the first.

### 3.7 Single `needs_action` label

`review` and `manual` were merged. The distinction was real but produced the same
user outcome: open the inbox and deal with it. Two labels for roughly two items a
month is over-engineering.

The distinction survives in the processing log's `status` and `note` columns,
where it costs nothing.

### 3.8 Every destination derives from issue date, never from run date

Folder year, folder month, and log sheet year all derive from the invoice's
issue date. Run date determines nothing except the value of the `run_date` audit
column.

This is the single most important invariant in the system. See section 4.8.

---

## 4. Functional specification

### 4.1 Mail ingress

A Gmail filter, configured once by hand in the Gmail UI:

```
Matches:  deliveredto:invoices@boom.haus
Actions:  Apply label "invoices/inbox"
          Skip the Inbox
          Mark as read
```

`deliveredto:` is preferred over `to:` because it reflects the envelope
recipient. It therefore catches mail where the alias is Bcc'd or appears only in
Cc, and it does not match mail merely Cc'd to the primary address.

**Do not enable "Never send it to Spam."** Anyone can mail this address.
Skip-inbox plus disabled spam filtering is how a hostile PDF reaches the pipeline
unseen. Spam protection stays on, and the visibility cost is bought back by the
weekly spam check in section 4.10.

The digest is sent to the primary address, which carries
`Delivered-To: <primary>` and therefore does not match this filter. No feedback
loop is possible.

### 4.2 Label state machine

```
invoices/inbox          applied by the Gmail filter on arrival
invoices/processed      terminal. Filed successfully, nothing needed
invoices/needs_action   terminal. Returned to inbox, marked unread
invoices/other          terminal. Classified not-an-invoice, never revisited
```

Daily query:

```
label:invoices-inbox -label:invoices-processed
-label:invoices-needs_action -label:invoices-other
```

**Gotcha:** Gmail search syntax does not accept a literal slash in `label:`. Use
the hyphenated form or a quoted `label:"invoices/inbox"`. The Apps Script API
(`GmailApp.getUserLabelByName`) takes the real slashed name. Two name forms for
the same label. Convert in exactly one helper and never hand-write a query
string.

**Re-queueing requires no code.** The query excludes terminal labels. Removing
`invoices/needs_action` from a thread makes it match again on the next run. This
is the retry mechanism for every failure path.

### 4.3 Allowlist

Location: `Accounting/processing_allowlist` (shared drive root, not year-scoped;
vendors outlive fiscal years).

| Column | Notes |
| --- | --- |
| `domain` | Exact match on the `From:` header domain |
| `approved` | Checkbox. Only `TRUE` permits filing |
| `vendor_name` | Human reference only |
| `notes` | Human reference only |

Matching rules:

- Match on the **`From:` header domain**, not the envelope sender. `Return-Path`
  is frequently an ESP bounce address such as `bounces.sendgrid.net`, which would
  effectively allowlist an entire mail provider.
- Exact string match. No wildcards. Large senders use several subdomains, so
  expect a few rows per vendor. The sheet stays under fifty rows.
- Normalize on read: lowercase, trim, strip a leading `@` or `www.`, discard
  empty rows.
- Reject any entry without a dot and report it in the digest as malformed. This
  catches the `x.co` typo case, which is otherwise indistinguishable from a
  vendor that was never added.
- **Fail closed.** Sheet unreachable, malformed, or missing a column: treat every
  sender as unapproved. Never fail open into auto-filing.

Bootstrap is manual. Seeding before the first run is optional; the first run is a
reasonable way to harvest the initial list from the digest.

### 4.4 Processing pipeline

Per message, strictly ordered. The allowlist check precedes both model passes, so
an unrecognized sender costs nothing at all.

```
1. Read From: header domain
2. Allowlist lookup
     miss -> needs_action, unread, move to inbox, log row (filed=false), STOP
3. Pass A: classify message and assign attachment roles
     not_invoice          -> other. Log row only if a PDF was attached
     invoice, no PDF      -> needs_action (portal link, non-PDF, in-body)
     invoice with PDF     -> continue
4. Pass B: extract structured data from each attachment with role=invoice
     failure after retries -> needs_action
5. Resolve target folders, write files to Drive
6. Append log rows, grouped by target year
7. Apply invoices/processed
```

Labeling is the last step. Any failure before step 7 leaves the message
unlabeled, so the next run retries it.

**Batch cap: 25 messages per run.** Leftovers are picked up the following day.
This is insurance against a post-outage backlog, not against normal volume.

### 4.5 Attachment roles

Pass A assigns one role per attachment:

| Role | Handling |
| --- | --- |
| `invoice` | Extract, file to `{MM}/invoices/` |
| `receipt` | File to `{MM}/receipts/`, no extraction |
| `supporting` | Not filed. Filename recorded in the log so it is known to exist |
| `irrelevant` | Ignored |

Motivating case: X (Twitter) sends `Invoice-{id}.pdf` and `Receipt-{id}.pdf` in
one email, sharing an identifier. Without role assignment both would be
extracted, both would produce near-identical log rows, and under a message-level
naming scheme both would collide on filename.

A third sibling folder for `supporting` was rejected. Folders for things never
opened are how a structure decays.

### 4.6 Drive layout

```
Accounting/                          (shared drive)
  processing_allowlist               (sheet, manually maintained)
  2026/
    processing_log_2026              (sheet, script-managed)
    08/
      invoices/
        2026-08-02T0737_x.com_Invoice-28671C0F-0019.pdf
      receipts/
        2026-08-02T0737_x.com_Receipt-28671C0F-0019.pdf
```

Implementation notes:

- Use the **Drive advanced service** (`Drive.Files.create`), not `DriveApp`.
  `DriveApp` does work against shared drives via `getFolderById`, but the
  advanced service is what Google documents for shared drives and it returns the
  file resource in one call. This is a preference, not a workaround for a known
  defect.
- Every list and create call needs `supportsAllDrives: true`, and every list also
  needs `includeItemsFromAllDrives: true`.
- The year folder holds both month folders and a sheet. `ensurePath` must filter
  on folder mimeType when resolving `{MM}`, or it can match the sheet.
- Both leaves are created lazily. Most months will have no receipts.
- Cache resolved folder IDs in Script Properties, keyed
  `folder:{yyyy}:{MM}:{leaf}`.
- Creating the log sheet: `SpreadsheetApp.create()` places the file in My Drive
  root and then requires a cross-drive move. Create it as a Drive file directly
  in the target folder and open it by ID instead:

  ```ts
  const file = Drive.Files.create(
    {
      name: `processing_log_${year}`,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [yearFolderId],
    },
    null,
    { supportsAllDrives: true },
  );
  const ss = SpreadsheetApp.openById(file.id);
  ```

### 4.7 Filename construction

```
{email_timestamp}_{sender_domain}_{original_attachment_filename}
2026-08-02T0737_x.com_Invoice-28671C0F-0019.pdf
```

The original filename is preserved in full, not slugged to a stem.

Sanitization is still mandatory:

- Strip `/`, `\`, and control characters.
- Collapse whitespace runs to `-`.
- Reject a leading dot; reject any `..` sequence.
- Leave diacritics and Czech characters intact. Drive handles them.
- Cap total length near 150 characters, truncating **only** the original-filename
  segment. The prefix is the part that cannot be lost.

The prefix also rescues the common case of vendors attaching `document.pdf` or
`invoice.pdf`.

Collision handling: list the target folder by name before creating, filtering out
folders. If the name is taken, append `_2`. Drive permits duplicate names
silently, so this check is the only thing preventing two same-named files with
different content.

### 4.8 Date handling

**Never construct a `Date` from `issue_date`.** `new Date("2026-08-01")` parses
as UTC midnight, and every downstream `getMonth()` is then at the mercy of the
runtime offset. The extracted value is a plain calendar date with no time
component. Treat it as a string:

```ts
const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(issueDate);
if (!m) return null;
const [, yyyy, mm] = m;
```

Zero timezone involvement, zero rounding, no way to land in the wrong month.

Independently, set the script timezone in `appsscript.json`:

```json
{ "timeZone": "Europe/Prague" }
```

That governs trigger firing and `Utilities.formatDate`, which is what produces
`email_timestamp`. Both are needed. Neither substitutes for the other.

Semantic validation of `issue_date`, in addition to format: reject anything more
than 24 months in the past or more than 1 month in the future. A model reading an
attacker-controlled PDF should not be able to choose an arbitrary folder.

### 4.9 Processing log

One sheet per year at `Accounting/{YYYY}/processing_log_{YYYY}`. The year is in
the filename as well as the path, because the file will eventually be opened from
a search result with no folder context.

**One row per attachment**, not per invoice. Append-only. Never rewrite a row.

```
run_date              audit only. The one field derived from the run
gmail_message_id
gmail_link
email_timestamp
sender_address
sender_domain
attachment_filename   original, unmodified
attachment_role       invoice | receipt | supporting | irrelevant
filed                 bool
final_filename
drive_folder_path
drive_link
vendor_name
vendor_ico
invoice_number
issue_date
due_date
total
currency
provider_id           which model produced the extraction
status                processed | needs_action | other
note                  error text, fallback reason, collision suffix
```

Also write a row, `filed = false`, for any message that **carried a PDF** and was
classified `not_invoice`. That is the most dangerous misclassification: a real
invoice silently dismissed, with no label anyone checks. Messages with no PDF
that classify as not-an-invoice get no row, or the sheet fills with newsletter
noise and stops being readable.

Write the whole run in one `setValues` per sheet, not `appendRow` in a loop.
Sheets calls are the slowest thing in Apps Script and there is a six minute
ceiling.

**A single run can write to two sheets.** A December invoice arriving 3 January
files into `Accounting/2026/12/invoices/` and its row belongs in
`processing_log_2026`. Group rows by target year and write once per sheet.
Resolving the sheet once at run start from `new Date().getFullYear()` puts
December's rows in the 2027 log, and the 2026 log then reports December as empty
during the fiscal close. Causes: late-arriving invoices, spam released after the
boundary, missed runs clearing a backlog, and reruns after a bug fix.

Rows with no usable issue date fall back to the run-date year and are flagged.
They require manual attention regardless.

### 4.10 Digest and heartbeat

Sent to the primary address, never to the alias.

**Actionable digest**, sent only when there is something to act on. Two sections,
because they require different responses:

- *Unknown senders.* `From:` domain, subject, attachment filenames. Nothing was
  classified, because nothing looked. Action: add the domain to the allowlist,
  remove the `needs_action` label.
- *Processing problems.* Portal links, non-PDF attachments, extraction failures.
  Action: file by hand. Each line states whether a file already exists in Drive,
  so nothing is double-filed.

Both link directly to the Gmail thread.

**Weekly heartbeat**, sent unconditionally on Mondays. Its purpose is to make
silence meaningful. Contents:

1. Counts for the week, plus links to the current log sheet and month folder.
2. **Spam check:** `in:spam deliveredto:invoices@boom.haus newer_than:8d`.
   Filters do not apply to spam, so a real invoice caught by the spam classifier
   receives no label and the daily run never sees it. This is the most likely way
   to lose an invoice entirely.
3. **Filter leak check:**
   `has:attachment filename:pdf newer_than:8d -label:invoices-inbox`. Surfaces a
   Gmail filter that has stopped matching.
4. **Aging check:** anything in `invoices/needs_action` older than 14 days, named
   explicitly. This is the second most likely way to lose an invoice: an unknown
   sender accumulates, the digest goes unread, and nothing errors. It also
   catches the case where a domain was added to the allowlist but the label was
   never removed.

Apps Script emails automatically on an uncaught exception. The moment the run is
wrapped in try/catch, that stops and failure notification is entirely owned by
this code. The catch block's last act must be sending the digest, and that send
must itself be failure-tolerant.

### 4.11 Error policy

**Extraction failure of any kind routes to `needs_action`.** No indefinite
retries, no distinction between transient and permanent at the label level. The
`note` column records which it was.

Two guards, because a naive version of this dumps an entire run into
`needs_action` during a provider outage and teaches the maintainer to ignore the
label:

- **In-run retry.** Three attempts at roughly 1s / 4s / 16s backoff. Absorbs
  transient 429 and 503 without touching the queue.
- **Circuit breaker.** If more than half the messages in a run fail extraction,
  abort the run, label nothing, send the digest with the error. A provider outage
  produces one alert, not fourteen items.

Known attachment edge cases, all routing to `needs_action`:

| Case | Behaviour |
| --- | --- |
| Password-protected PDF | Fails hard, not gracefully. Detect and route |
| Image-only scan | Works via vision, costs more. Allowed |
| Oversized file | Exceeds the API document limit. Enforce a size ceiling before the call |
| Non-PDF attachment (ISDOC XML, JPG, ZIP) | Rule, not a model decision. No `application/pdf` attachment means `needs_action` |

ISDOC is structured XML and is strictly easier to parse than a PDF, no model
required. If a vendor starts sending it, that is a future upgrade, not a problem.

### 4.12 Security invariants

These are the properties that must hold. Each is testable.

1. **The daily query is always anchored on `label:invoices-inbox`.** Apps Script
   OAuth cannot be narrowed to a label, so the script has full personal mailbox
   access and containment is behavioural. Assert per message, before any Drive
   write or label change, that the message actually carries the label. A bug in a
   query string must never be able to reach personal mail.
2. **No unallowlisted sender's bytes reach Drive.**
3. **Model output never becomes a path segment unsanitized.** A PDF is
   attacker-controlled text feeding a model whose output selects a filesystem
   location. Constrain the output; do not trust it. Sanitize per section 4.7 and
   validate dates per section 4.8.
4. **Fail closed on allowlist read failure.**
5. **The script never deletes or archives mail, and never writes to the
   allowlist sheet.**

---

## 5. Data contracts

```ts
// providers/types.ts

/** Pure. Performs no I/O. The environment owns transport. */
export interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export type AttachmentRole = 'invoice' | 'receipt' | 'supporting' | 'irrelevant';

export interface ClassificationResult {
  isInvoice: boolean;
  reason: string;
  attachments: { filename: string; role: AttachmentRole }[];
}

export interface InvoiceData {
  vendorName: string | null;
  vendorIco: string | null;
  invoiceNumber: string | null;
  issueDate: string | null;   // ISO 8601 calendar date, validated as a string
  dueDate: string | null;
  total: number | null;
  currency: string | null;
}

export interface ExtractionProvider {
  readonly id: string;
  buildClassifyRequest(input: MessageMetadata, apiKey: string): HttpRequest;
  parseClassifyResponse(rawBody: string): ClassificationResult;  // throws
  buildExtractRequest(pdfBase64: string, apiKey: string): HttpRequest;
  parseExtractResponse(rawBody: string): InvoiceData;            // throws
}
```

Both provider methods are pure. No network in unit tests.
`parseResponse` normalizes each provider's shape, so the caller never learns
which model produced the result.

The interface deliberately contains no `Promise`. Apps Script's `UrlFetchApp` is
synchronous and Node's `fetch` is not. An async interface forces faking async in
Apps Script or faking sync in Node. Transport lives outside the interface:

```ts
// adapters/http.ts (Apps Script)
const res = UrlFetchApp.fetch(req.url, {
  method: 'post',
  contentType: 'application/json',
  headers: req.headers,
  payload: req.body,
  muteHttpExceptions: true,
});
return provider.parseExtractResponse(res.getContentText());
```

The local harness uses `fetch` against the same provider objects, unchanged.

---

## 6. Repository layout

```
src/
  main.ts              trigger entry points, nothing else
  run.ts               orchestration
  config.ts            Script Properties access, constants

  pure/                no Google globals. Enforced by lint
    naming.ts          sanitize, build filename, collision suffix
    dates.ts           issue date -> {year, month} strings, window validation
    domains.ts         normalize From: domain, allowlist matching
    query.ts           daily query builder, label name conversion
    routing.ts         classification result -> target leaf
    grouping.ts        rows -> Map<year, rows[]>
    validate.ts        InvoiceData schema plus semantic checks

  adapters/
    gmail.ts           GmailApp only
    drive.ts           Drive advanced service only
    sheets.ts          SpreadsheetApp only
    http.ts            UrlFetchApp only

  providers/
    types.ts
    anthropic.ts       buildRequest / parseResponse, both pure
    registry.ts

test/
  pure/                mirrors src/pure. No mocks
  fixtures/            saved raw API responses for golden-file tests

tools/
  esbuild.config.ts
appsscript.json
```

**Nothing under `pure/` imports a Google global.** Enforce with
`no-restricted-globals` for `GmailApp`, `DriveApp`, `Drive`, `SpreadsheetApp`,
`Utilities`, `UrlFetchApp`, scoped to that directory. This is the single cheapest
thing preventing the architecture from eroding.

### Runtime constraints

Target `es2019`. V8 supports more; nothing needed lives above that line.

| Not available | Use instead |
| --- | --- |
| npm at runtime, ES modules | esbuild bundle to a single IIFE |
| `fetch` | `UrlFetchApp` (synchronous) |
| `crypto` | `Utilities.computeDigest` |
| `Buffer` | `Utilities.base64Encode` |
| Meaningful `async`/`await` | Nothing. Every Apps Script service is blocking. Do not introduce promises |

**The build gotcha:** Apps Script triggers bind to global function names, and an
IIFE exposes nothing. Add a footer shim:

```ts
// tools/esbuild.config.ts
{
  globalName: 'App',
  footer: {
    js: 'function dailyRun() { return App.dailyRun(); }\n' +
        'function weeklyHeartbeat() { return App.weeklyHeartbeat(); }',
  },
}
```

Two files ship: `bundle.js` and `appsscript.json`.

### Dependencies

Ship zero.

Zod is the obvious candidate for validating extraction output and it is a close
call. Against: there is exactly one schema, and the validation that matters is
semantic, not structural. "Is `issueDate` a well-formed ISO date" is the easy
half. "Is it within the sane window" is the half that prevents a misfiled invoice,
and Zod does not write that. Hand-rolled, the whole validator is about 40 lines.
For: better error strings, which land in the log's `note` column.

Default to none. Add it if the hand-rolled validator starts sprawling.

### Testing policy

Not about code quality. This runs unattended, touches accounting records, and
fails silently. Nobody is watching.

**Test the pure layer.** Vitest, node environment, no mocks of any kind. Roughly
forty tests, one afternoon. Every entry below is a real failure mode identified
during design, and every one is silent in production.

| Module | Bug it catches |
| --- | --- |
| `naming` | Path traversal from an attacker-controlled filename, length overflow, unicode, collision suffix |
| `dates` | Month-boundary error, malformed date, date outside the sane window |
| `domains` | The `x.co` typo case, `@` prefix, casing, trailing whitespace |
| `validate` | Model returns prose instead of JSON, missing field, `null` where a number was promised |
| `query` | The label-exclusion invariant silently widening |
| `grouping` | The January two-sheet case |
| `routing` | Receipt filed into the invoices leaf |

**Do not test the adapters.** Mocking `DriveApp` to assert the mock was called
proves nothing, and there is no meaningful Apps Script test harness. Building one
is a larger project than this one.

**Add golden-file tests** on `parseResponse` against saved raw API responses.
When the model or provider changes, this is what confirms the parser still holds.

**Dry-run mode is worth more than any test here.** A `DRY_RUN` Script Property:
everything runs, classification and extraction included, the digest sends,
nothing is written to Drive or the log. Point it at the real mailbox for a week.
It will surface vendor quirks no fixture would have predicted.

**Staging** is a second Apps Script project pointed at a scratch shared drive via
Script Properties. Two `.clasp.json` files, switched by a script. Push there
first, always.

### Deployment

Manual `clasp push`. CI deployment requires storing `.clasprc.json`, a live
refresh token to the Google account, in a GitHub secret. For a solo project
deploying monthly at most, that is a real security cost buying nothing.

Do run `tsc --noEmit && vitest run` on push. That part is free.

---

## 7. Implementation plan

Eleven steps. Each is independently reviewable, each leaves the system in a
working state, and the destructive capability (writing to Drive) arrives late and
behind a flag.

Review each step against its acceptance criteria before starting the next.

---

### Step 0. Google-side setup (no code)

**Goal.** Everything the script assumes to exist, exists.

**Deliverables**

- Gmail filter per section 4.1. Verify by mailing the alias from an outside
  address and confirming the label appears and the inbox is skipped.
- Four labels created: `invoices/inbox`, `invoices/processed`,
  `invoices/needs_action`, `invoices/other`.
- `Accounting/processing_allowlist` sheet with headers and a checkbox data
  validation on `approved`. Seed two or three known vendors.
- Confirm the `Accounting` shared drive ID and record it.
- Anthropic API key issued, spend limit set.

**Acceptance**

- A test email to the alias lands labeled, unread state as configured, not in the
  inbox.
- The allowlist checkbox is tappable from the Drive mobile app.

**Review checklist**

- [ ] "Never send it to Spam" is NOT checked
- [ ] Filter predicate is `deliveredto:`, not `to:`
- [ ] Label names use slashes, not underscores or hyphens

---

### Step 1. Repository scaffold and a deploy that does nothing

**Goal.** Prove the whole toolchain end to end before any logic exists.

**Deliverables**

- TypeScript config targeting `es2019`, `@types/google-apps-script`.
- esbuild config producing a single IIFE with the global-function footer shim.
- `appsscript.json` with `timeZone: "Europe/Prague"`, explicit `oauthScopes`, and
  the advanced Drive service under `dependencies.enabledAdvancedServices`.
- Two `.clasp.json` files (staging, production) and a switch script.
- Vitest configured. One trivial passing test.
- ESLint with `no-restricted-globals` scoped to `src/pure/`.
- `main.ts` exporting `dailyRun` that logs a line and returns.

**Acceptance**

- `npm run build && npm run push:staging` succeeds.
- `dailyRun` is selectable and runnable from the Apps Script editor. This is
  where the IIFE footer shim is proven; without it the function is invisible.
- The lint rule fails a deliberate `GmailApp` reference inside `src/pure/`.

**Risk.** Advanced Drive service must be enabled in the editor UI as well as
declared in `appsscript.json`. Forgetting produces a confusing
`Drive is not defined` much later. Verify now with a one-line
`Drive.Drives.list()` call.

---

### Step 2. The pure core, with tests

**Goal.** All decision logic, fully tested, before anything can call it.

No Google globals appear in this step at all.

**Deliverables**

- `pure/naming.ts`, `pure/dates.ts`, `pure/domains.ts`, `pure/query.ts`,
  `pure/routing.ts`, `pure/grouping.ts`, `pure/validate.ts`.
- The full test table from section 6.

**Acceptance**

Named cases that must pass:

- `naming`: a filename of `../../../etc/passwd` produces a safe name; a 400
  character filename truncates the original segment only, never the prefix; Czech
  diacritics survive; a duplicate produces `_2`.
- `dates`: `2026-08-01` yields `{year:'2026', month:'08'}` regardless of process
  timezone; run the suite under `TZ=Pacific/Kiritimati` and `TZ=Pacific/Midway`
  in CI and get identical results; `2019-01-01` and `2030-01-01` are both
  rejected by the window check.
- `domains`: `X.COM`, ` x.com `, `@x.com`, `www.x.com` all match an allowlist
  entry of `x.com`; `x.co` does not.
- `query`: adding a label to the terminal set changes the built query; the query
  always contains the `invoices-inbox` anchor.
- `grouping`: rows dated 2026-12 and 2027-01 in one run produce two groups.
- `validate`: prose instead of JSON throws; a missing `issueDate` yields a
  fallback signal rather than a crash.

**Review checklist**

- [ ] No `new Date(issueDate)` anywhere in the codebase
- [ ] Every sanitizer is allowlist-based, not denylist-based
- [ ] Timezone-varying CI run is wired up

---

### Step 3. Adapters

**Goal.** Thin, dumb wrappers over Google services. No decisions.

**Deliverables**

- `adapters/gmail.ts`: search by query, read message metadata and attachments,
  add and remove labels, move to inbox, mark unread, send mail.
- `adapters/drive.ts`: resolve shared drive by name, `ensurePath`, list by name,
  create file, create sheet in a folder.
- `adapters/sheets.ts`: read a sheet to a matrix, batch append.
- `adapters/http.ts`: `UrlFetchApp` wrapper with retry and backoff.
- `config.ts`: typed Script Properties access with defaults.

**Acceptance**

Verified by hand from the Apps Script editor against the staging drive, not by
unit test:

- `ensurePath('2026','08','invoices')` creates the tree and returns an ID.
- Called a second time it returns the same ID from cache without new API calls.
- A sheet placed in the year folder does not confuse month resolution.
- `Drive.Files.create` with `supportsAllDrives: true` writes into the shared
  drive successfully.

**Review checklist**

- [ ] Every Drive call passes `supportsAllDrives: true`
- [ ] Every Drive list also passes `includeItemsFromAllDrives: true`
- [ ] `ensurePath` filters on folder mimeType
- [ ] No business logic in any adapter

---

### Step 4. Allowlist gate and labeling. No filing.

**Goal.** The first genuinely useful behaviour, and the first that touches real
mail. Nothing is written to Drive.

**Deliverables**

- Read and normalize the allowlist, with fail-closed behaviour and malformed
  entry detection.
- Build and run the daily query, batch cap 25.
- Per message: assert the `invoices/inbox` label is present, extract the `From:`
  domain, look it up.
- Unrecognized: apply `needs_action`, move to inbox, mark unread.
- Recognized: leave unlabeled for now, log to the Apps Script console.
- Manual trigger only, no time-driven trigger yet.

**Acceptance**

- Run against the real mailbox. Every unknown sender appears in the inbox,
  unread, labeled.
- Removing the label from a thread causes the next run to see it again.
- Renaming the allowlist sheet causes every message to be treated as unknown, and
  nothing crashes.

**Risk.** This is the first step that can mislabel real mail. The invariant
assertion from section 4.12 must be in place before running it.

---

### Step 5. Pass A classification

**Goal.** Every allowlisted message is classified, with attachment roles
assigned. Still nothing written to Drive.

**Deliverables**

- Anthropic provider `buildClassifyRequest` and `parseClassifyResponse`, both
  pure, both unit tested against saved fixtures.
- Wire into `run.ts`: `not_invoice` gets `other`; invoice without a PDF gets
  `needs_action`; invoice with a PDF logs its role assignment and stops.
- Circuit breaker and in-run retry per section 4.11.

**Acceptance**

- The X email produces exactly one `invoice` role and one `receipt` role.
- A newsletter from an allowlisted domain classifies `not_invoice`.
- A portal-link invoice classifies as an invoice with no PDF and lands in
  `needs_action`.
- Forcing a 500 from the provider on more than half the batch aborts the run and
  labels nothing.

**Review checklist**

- [ ] Classification never sees PDF bytes, only metadata and body text
- [ ] Body text is truncated before being sent
- [ ] Unknown senders still never reach this step

---

### Step 6. Pass B extraction

**Goal.** Structured data from invoice PDFs. Still nothing written to Drive.

**Deliverables**

- `buildExtractRequest` and `parseExtractResponse`.
- Size ceiling check and password-protected detection before the call.
- Full validation chain: structural, then semantic date window, then
  sanitization.
- Log extracted data to the console with the resolved target path it *would* use.

**Acceptance**

- A real invoice yields a correct `issueDate` and a correct target path.
- A PDF whose text contains an instruction to alter the output does not change
  the target path. Construct this fixture deliberately.
- An out-of-window date falls back rather than being used.
- Oversized and encrypted PDFs route to `needs_action` without an exception.

---

### Step 7. Drive filing

**Goal.** Files land. This is the first destructive step.

**Deliverables**

- Resolve leaves, check for collision, create the file.
- Receipts filed into the same month folder as their invoice, derived from the
  invoice's issue date, not the receipt's own date. A pair split across two month
  folders is worse than either placement alone.
- Standalone receipt with no invoice in the message: fall back to its own date,
  then to the email timestamp. Flag it.
- `supporting` attachments not filed.

**Acceptance**

- Run against **staging drive only** first.
- The X email produces one file in `invoices/` and one in `receipts/`, both under
  the same month.
- A deliberately duplicated filename produces `_2`.
- A December-issued invoice processed in January lands in `2026/12/`.

**Review checklist**

- [ ] Filing happens before labeling, never after
- [ ] Collision check filters folders out of the name listing
- [ ] `receipts/` is created lazily

---

### Step 8. Processing log

**Goal.** Every processed attachment is recorded, in the right year's sheet.

**Deliverables**

- `ensureYearSheet(year)`: create via `Drive.Files.create`, set headers, freeze
  row 1, cache the ID by year.
- Group rows by target year, one `setValues` per sheet.
- Dedupe set: load `gmail_message_id + attachment_filename` from the current and
  previous year at run start.
- Rows for PDF-bearing messages classified `not_invoice`.

**Acceptance**

- A synthetic batch spanning 2026-12 and 2027-01 writes to two sheets and creates
  the 2027 sheet mid-run.
- The dedupe set prevents a double file after a simulated crash between the Drive
  write and the label write.
- Message ID alone is insufficient as a key: verify with the X email, whose two
  attachments share one message ID.

**Rationale for the two-year lookback.** The Gmail terminal label is the primary
dedupe. The log only guards the narrow window where the script crashed between
the Drive write and the label write, and that retry happens on the next daily
run. Two years is generous. An invoice arriving thirteen months late would evade
it and would be a problem for other reasons.

---

### Step 9. Digest and heartbeat

**Goal.** The system becomes observable. Silence becomes meaningful.

**Deliverables**

- Actionable digest, two sections, sent only when non-empty, to the primary
  address.
- Weekly heartbeat with all four checks from section 4.10.
- A second time-driven trigger for the heartbeat.
- Top-level try/catch whose final act is a failure-tolerant digest send.

**Acceptance**

- The digest lands in the primary inbox and does **not** acquire
  `invoices/inbox`. This confirms the feedback loop is closed.
- Each digest line links to the correct Gmail thread.
- Manually place a message in spam and confirm the heartbeat's spam check finds
  it.
- Manually age a `needs_action` thread past 14 days and confirm it is named.

---

### Step 10. Go live

**Goal.** Unattended operation.

**Deliverables**

- Point production `.clasp.json` at the production project and the real
  `Accounting` drive.
- `DRY_RUN = true`. Run for one week against the real mailbox with no writes.
- Review the console output and digests. Fix what surfaces.
- `DRY_RUN = false`. Install the daily time-driven trigger.

**Acceptance**

- Seven consecutive dry-run days with no unexplained output.
- First live week: every invoice filed correctly, spot-checked by hand against
  the mailbox.

**Note.** Apps Script triggers fire within an hour window, not at a specific
time. "Between 6am and 7am" is the available granularity. Irrelevant here,
surprising the first time.

---

### Step 11. Year rollover verification (before December)

**Goal.** Prove the code path that has never executed.

**Deliverables**

- A test invocation with a forced future issue date creating `2027/`,
  `2027/01/invoices/`, and `processing_log_2027`.
- Delete the artifacts afterward.

**Acceptance**

- No manual setup was required.
- Rollover bugs are the classic case of code that has never run until the day it
  matters. Do not skip this.

---

## 8. Deferred

**Evaluation harness.** A local CLI over a fixture directory of real invoice
PDFs, each with a hand-written `expected.json`. Runs every registered provider
against every fixture and prints per-field accuracy, latency, and token cost.
Weight `issueDate` separately, since it is the only extracted field that changes
where a file lands.

Deferred because it needs real mail to build against. Note that cost is not the
motivation. At this volume the annual spend is under two dollars. The harness
exists for accuracy comparison and to avoid a single-vendor dependency. Do not
let cost optimization drive design decisions here.

**ISDOC XML parsing.** If a Czech vendor starts sending it, structured XML is
strictly easier than a PDF and needs no model.

**Per-vendor rules.** Explicitly rejected, recorded here so the decision is not
accidentally revisited. See section 3.6.

---

## Appendix A. Script Properties

| Key | Example | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Never in the repo, never in `appsscript.json` |
| `ACCOUNTING_DRIVE_ID` | `0AB...` | Resolved once, cached |
| `DRY_RUN` | `true` / `false` | Everything runs, nothing is written |
| `BATCH_CAP` | `25` | Messages per run |
| `DIGEST_TO` | primary address | Never the alias |
| `PROVIDER_ID` | `anthropic-haiku` | Selects from the provider registry |
| `folder:2026:08:invoices` | Drive folder ID | Cache entry, written by the script |
| `sheet:2026` | Spreadsheet ID | Cache entry, written by the script |

Declare `oauthScopes` explicitly in `appsscript.json` rather than letting Apps
Script infer them. Inference tends to over-request, and the granted list should
be readable.

## Appendix B. Invariant summary

Reread before any change to the pipeline.

1. Every destination derives from issue date. Run date determines only
   `run_date`.
2. The daily query is always anchored on `label:invoices-inbox`, and the anchor
   is asserted per message.
3. No unallowlisted sender's bytes reach Drive.
4. Model output is sanitized and range-validated before becoming a path.
5. Allowlist read failure fails closed.
6. Filing precedes labeling. Labeling is always the last action.
7. The script never writes to the allowlist, and never deletes or archives mail.
