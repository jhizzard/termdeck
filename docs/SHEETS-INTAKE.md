# Google Sheets intake ramp

**The quick-capture path into memory.** Add a row to a Google Sheet — from a
phone, from a Gemini-web chat, from a browser tab — and it arrives in Mnestra's
`memory_inbox` as a **proposal**, on the same quarantined channel the Bridge's
`memory_propose` tool uses. An asynchronous promotion pass later promotes it to
canonical memory or rejects it.

A row in this sheet is **not** a memory. It is a proposal for one.

Shipped in Sprint 84 (arc step 4.2). Code lives in
`packages/mcp-bridge/src/harvest/`; tests in
`packages/mcp-bridge/test/harvest-sheets.test.js`.

---

## Sheet schema

One tab, six columns, a single header row. Column letters are load-bearing —
the harvester addresses cells by position, not by header text, so **do not
reorder or insert columns**.

| Col | Header         | Who writes it | Meaning |
|-----|----------------|---------------|---------|
| A   | `ts`           | you           | When you captured it. Free-form; copied into the proposal's metadata as `captured_at`. Optional. |
| B   | `source`       | you           | Which surface this came from: `gemini-web`, `claude-web`, `chatgpt-web`, `grok-web`. **Leave blank for the default** (`gemini-web`). |
| C   | `project`      | you           | Project slug hint, e.g. `termdeck`. Blank falls back to `TERMDECK_SHEETS_DEFAULT_PROJECT`. Advisory — the promotion pass may re-map it. |
| D   | `text`         | you           | **Required.** The proposed memory, ≤ 4000 characters. Durable, kitchen-level facts and decisions — not chat ephemera. |
| E   | `forwarded_at` | the harvester | ISO timestamp stamped once the proposal is accepted by the inbox. **Never edit this.** A non-empty value means "done, skip forever." |
| F   | `note`         | the harvester | Why a row was *not* forwarded. Harvester notes begin with `[harvest]`. |

Suggested header row (row 1):

```
ts | source | project | text | forwarded_at | note
```

### Rules the sheet must obey

- **Append-only.** New captures go at the bottom. The harvester's fingerprint is
  `sha256(spreadsheet id + tab + row number + columns A–D)`, so row numbers must
  be stable. Sorting, inserting rows in the middle, or deleting rows re-numbers
  everything below and will cause **re-proposals of rows that were already
  forwarded**.
- **Column A must be a static value, not a volatile formula.** If you put
  `=NOW()` or `=TODAY()` in the timestamp column, its value changes on every
  read — the harvester will see the row as edited on every single pass and will
  never mark it forwarded. Paste a fixed timestamp (Ctrl+Shift+; in Sheets), or
  leave column A empty.
- **Never delete rows.** The harvester never deletes either — "mark forwarded,
  never delete" is the contract in both directions. Archive by moving old rows
  to a different *tab* if the sheet gets long.
- **Column F is the harvester's.** You *may* write your own note there; the
  harvester detects that it isn't one of its own (no `[harvest]` prefix) and
  leaves it alone, stamping only column E. But it is simpler to leave F empty.

---

## Activation

Four operator steps. Nothing here is automated on purpose — it mints a
credential, and that should be a deliberate act.

### 1. Mint a service account

In the Google Cloud console, on any project:

1. **APIs & Services → Enable APIs → Google Sheets API** → Enable.
2. **IAM & Admin → Service Accounts → Create service account.** Name it
   something like `termdeck-sheets-harvester`. It needs **no** IAM roles — its
   access comes from sheet sharing, not from project IAM.
3. On the new account: **Keys → Add key → Create new key → JSON**. A `.json`
   file downloads. Move it somewhere private, e.g.:

   ```bash
   mkdir -p ~/.termdeck/credentials
   mv ~/Downloads/<project>-<hash>.json ~/.termdeck/credentials/sheets-harvester.json
   chmod 600 ~/.termdeck/credentials/sheets-harvester.json
   ```

   **Do not put this file in the repo.** It contains a private key; the
   pre-commit gitleaks hook will block it, but the right place is outside the
   working tree entirely.

### 2. Share the sheet with the service account

Open the service-account JSON and copy its `client_email` (it looks like
`termdeck-sheets-harvester@<project>.iam.gserviceaccount.com`). In the Google
Sheet: **Share → paste that address → Editor → Send.**

Editor, not Viewer — the harvester stamps `forwarded_at` back into the row.
That write-back is what makes the whole thing idempotent, so read-only access
is not a valid configuration.

### 3. Set the environment contract

Add to `~/.termdeck/secrets.env` (credential) and `~/.termdeck/supervisor.env`
(configuration):

```bash
# ~/.termdeck/secrets.env
TERMDECK_SHEETS_SA_KEY_FILE=/Users/<you>/.termdeck/credentials/sheets-harvester.json

# ~/.termdeck/supervisor.env
TERMDECK_SHEETS_INTAKE_ENABLED=1
TERMDECK_SHEETS_SPREADSHEET_ID=<the id from the sheet URL>
TERMDECK_SHEETS_TAB=Intake
TERMDECK_SHEETS_DEFAULT_PROJECT=termdeck
```

The spreadsheet id is the long token in the URL between `/d/` and `/edit`:
`https://docs.google.com/spreadsheets/d/`**`1AbC_dEf-Ghi...`**`/edit`.

### 4. Smoke it

Put one row in the sheet (leave E and F empty), then:

```bash
cd packages/mcp-bridge
node src/harvest/run.js --once
```

Expected:

```
sheets-harvest: tab 'Intake' rows from 2, default source_agent gemini-web, ledger /Users/<you>/.termdeck/sheets-harvest-ledger.jsonl
sheets-harvest: scanned=1 proposed=1 already=0 quarantined=0 refused=0 uncertain=0 restamped=0 deferred=0
```

…and column E of that row now carries an ISO timestamp. Run it a second time:
`proposed=0`. That is the idempotency working.

To leave it running on the local timer, drop `--once`.

---

## Environment contract

| Variable | Default | Meaning |
|---|---|---|
| `TERMDECK_SHEETS_INTAKE_ENABLED` | *(off)* | `1` to run. The runner exits immediately otherwise (`--force` overrides for a one-shot). |
| `TERMDECK_SHEETS_SPREADSHEET_ID` | *(required)* | The sheet to harvest. |
| `TERMDECK_SHEETS_TAB` | `Intake` | Tab title. Apostrophes are handled. |
| `TERMDECK_SHEETS_HEADER_ROWS` | `1` | Rows to skip at the top. |
| `TERMDECK_SHEETS_DEFAULT_PROJECT` | *(none)* | Project hint when column C is blank. |
| `TERMDECK_SHEETS_DEFAULT_SOURCE_AGENT` | `gemini-web` | Used when column B is blank. Only the four `*-web` values are accepted; anything else falls back to `gemini-web`. |
| `TERMDECK_SHEETS_MAX_ROWS_PER_RUN` | `100` | Proposals per pass. Excess rows are **deferred to the next pass, never dropped** (and the count is logged). |
| `TERMDECK_SHEETS_POLL_INTERVAL_MS` | `300000` | Local timer interval (5 min). |
| `TERMDECK_SHEETS_LEDGER_FILE` | `~/.termdeck/sheets-harvest-ledger.jsonl` | The dedup ledger. See below. |
| `TERMDECK_SHEETS_SA_KEY_FILE` | *(none)* | Path to the service-account JSON. Falls back to `GOOGLE_APPLICATION_CREDENTIALS`. |
| `TERMDECK_SHEETS_SA_EMAIL` / `TERMDECK_SHEETS_SA_PRIVATE_KEY` | *(none)* | Inline alternative to the key file. Literal `\n` in the PEM is unescaped for you. Env wins over the file. |
| `MNESTRA_WEBHOOK_URL` | `http://localhost:37778/mnestra` | Where proposals go. |
| `MNESTRA_WEBHOOK_SECRET` | *(none)* | Sent as `x-mnestra-secret`. Required by Mnestra ≥ 0.7.0. |

No new npm dependency is introduced. The service-account flow is an RS256 JWT
signed with `node:crypto` and exchanged at `oauth2.googleapis.com/token`; the
Sheets calls are plain REST over the Bridge's existing HTTP helper.

---

## How it behaves

### Cadence: a local timer, not `pg_cron`

The forward path terminates at `http://localhost:37778` — the Mnestra webhook
on your own machine — and both the service-account key and the dedup ledger are
local files. A Supabase `pg_cron` job can reach none of the three. So this runs
as a local supervised process, every 5 minutes by default. That is a
consequence of the topology, not a preference.

### Idempotency, and what happens when it crashes

Two writes happen per row, and they are not in one transaction: the proposal
INSERT (over the network to the webhook) and the `forwarded_at` stamp (over the
network to Google). A crash between them would, naively, re-propose the row on
the next pass — the sheet still looks unforwarded.

The sheet therefore cannot be the dedup substrate. A local append-only ledger
is, and it is written **before** the insert:

```
append {phase:'inflight'}  →  propose()  →  append {phase:'forwarded', id}
     (fsync'd here)                              (fsync'd here)
```

On rerun, a fingerprint present in the ledger in **any** phase is never
proposed again:

| Ledger state on rerun | What happens |
|---|---|
| `forwarded` | The sheet is re-stamped from the ledger's timestamp. No second proposal. |
| `inflight` only | Indeterminate — the insert may or may not have landed. The row is stamped with a visible `[harvest] in-flight when the harvester stopped` note and **never retried**. |
| `rejected` | The inbox refused it (a definitive HTTP 400). The reason is written to column F. Edit the text to retry. |

That middle row is a deliberate asymmetry: one visible maybe-unforwarded row
that you can see and re-enter is better than a silent duplicate in canonical
memory. Duplicates are the failure mode worth paying for.

If the *write-back* fails (Sheets 5xx), nothing is lost — every forwarded row is
already durable in the ledger, so the next pass re-stamps rather than
re-proposing.

### Editing a row while a pass is running

The sheet is a live document, and a pass takes a few seconds. If you edit a row
after the harvester has read it but before it stamps, the harvester **will not
mark that row forwarded** — it re-reads the range immediately before writing and
drops any stamp whose row no longer matches what it acted on.

What that means for you:

- The row as it was *when the pass started* has already been proposed. That
  proposal stands (it goes through the same review as any other).
- Your **edit is not lost.** The row stays unforwarded, and the next pass
  proposes the edited row. Because the fingerprint hashes the content, an edited
  row is a genuinely new fingerprint — a new proposal, not a duplicate of the
  old one.
- You'll see `mutatedSkipped=1` in the run summary and a `row N: mutated` line.

**One fingerprint, two jobs.** The same hash is both the dedup key ("have I
proposed this row?") and the mid-pass guard ("is this still the row I acted
on?"), and it covers **all four** columns you author — `ts`, `source`,
`project`, `text`. That matters: changing only the project column produces a
different proposal, so it has to count as a different row. An earlier version
used a narrower dedup key over just the text, and a project-only edit was
invisible to it — the second pass saw an "unchanged" row, skipped it as already
forwarded, and stamped over the edit. Writing to E or F is the harvester's own
job and never trips the guard.

This narrows the window to the milliseconds between the verification read and
the write; it does not eliminate it, because the Sheets values API has no
compare-and-swap. In practice, edit freely — the worst case is that a capture
waits one extra polling interval.

### Quarantine

A row that cannot be forwarded is **never silently dropped and never fatal to
the batch** — the rest of the rows in the pass still go through. It gets a note
in column F:

| Note | Cause | Fix |
|---|---|---|
| `not forwarded: empty text — column D is required` | Blank text with other cells filled | Fill column D |
| `not forwarded: unknown source "…"` | Column B isn't one of the four `*-web` values | Correct it, or blank it for the default |
| `not forwarded: text is N chars, over the 4000 cap` | Too long | Shorten it |
| `not forwarded: contains material matching secret/denylist rule class(es): …` | The ingress scan found a credential | Remove the secret and rephrase |
| `refused by the memory inbox: …` | The webhook validated and refused | Edit the text to retry |

Quarantine is **re-derived on every pass**, not recorded — so fixing *any*
offending cell un-sticks the row on the next run, even if the text is unchanged.

The note names only the **rule class** for a secret hit, never the matched text.
A secret is refused, not scrubbed-and-forwarded: a silently-sanitized memory is
a corrupted memory.

### Why a sheet row gets scanned for secrets at all

Same reason the Bridge's proposal channel does. A proposal is ingress that — if
promoted — later egresses into every CLI session through recall. So sheet rows
are scanned with the identical rule set and the identical reject-don't-scrub
policy as `memory_propose`.

### Identity

`source_agent` comes from column B, validated against the canonical web
vocabulary (`claude-web` · `chatgpt-web` · `grok-web` · `gemini-web`) and
defaulting to `gemini-web`. A value that is present but invalid is
**quarantined, never coerced** — silently turning a typo into `gemini-web`
would launder a wrong provenance into canonical memory. CLI identities
(`claude`, `codex`, `gemini`, `grok`, `orchestrator`) are not representable
from a sheet, by construction, and Mnestra's RPC whitelist rejects them again
server-side.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Google service-account credentials are not configured` | No `TERMDECK_SHEETS_SA_KEY_FILE` / inline pair. See § Activation step 3. |
| `Google token exchange rejected (HTTP 401) — invalid_grant: Invalid JWT Signature` | The private key doesn't match the service account, or the PEM was mangled in transit. Prefer the key file over the inline env var. |
| `HTTP 403 — The caller does not have permission` | The sheet isn't shared with the service account's `client_email`, or it's shared as Viewer instead of Editor. |
| `HTTP 400 — Unable to parse range` | `TERMDECK_SHEETS_TAB` doesn't match the tab title exactly (it is case- and space-sensitive). |
| Rows forward but nothing appears in recall | Expected. Proposals sit in `memory_inbox` with `status='pending'` and are invisible to every recall path until the promotion pass promotes them. |
| A row proposed twice | Almost certainly the sheet was sorted or a row was inserted/deleted mid-sheet, changing row numbers. See § Rules the sheet must obey. |

## Out of scope

The phone shortcut / UI side of this (an iOS Shortcut, a Google Form, a Gemini
extension that appends rows) is an operator setup step, not code in this repo.
Anything that can append a row to the tab works — the harvester does not care
what wrote it.
