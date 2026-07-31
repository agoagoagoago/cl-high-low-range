# CL High/Low Range

Time-weighted high/low range projection, run over two instruments:
**CLU26** (Crude Oil WTI Sep '26) and the **Emini S&P 500**.

## Files

| File | Role |
|---|---|
| `clu26_price_history.csv` | Crude dataset. **System of record.** |
| `es_price_history.csv` | Emini dataset. Header only until the user pastes rows. |
| `analyze.py` | Weighting, integrity checks, projection. **Crude only.** |
| `web/algo.js` | Same algorithm in JS, for the browser. Must stay in parity. |
| `web/parity.test.mjs` | Asserts `algo.js` == `analyze.py`, plus instrument isolation and page drift. |
| `web/instruments.js` | Per-instrument config. The isolation boundary — see below. |
| `web/app.js`, `styles.css` | Shared UI, used by both pages. |
| `web/index.html` | Crude page. **Edit this one**, then regenerate `es.html`. |
| `web/es.html` | Emini page. Generated — never hand-edit. |
| `web/seed.js` | Crude baseline, generated from the CSV — do not hand-edit. |

## Web app

Repo: `agoagoagoago/cl-high-low-range` (public) · static, no build step, zero deps.

**Two instruments, two pages, one codebase:**

| Page | Instrument | Data |
|---|---|---|
| https://cl-high-low-range.vercel.app/ | Crude Oil (CLU26) | `clu26_price_history.csv`, 63-row seed |
| https://cl-high-low-range.vercel.app/es | Emini S&P 500 | `es_price_history.csv`, starts empty |

`web/instruments.js` holds one config per instrument; the page declares which it is via
`<body data-instrument="cl|es">` and `app.js` resolves it. **`store`, `idb` and `csv` must
stay unique per instrument** — they are the only thing keeping the two datasets from
overwriting each other. The parity test asserts uniqueness; do not relax it.

`web/es.html` is a generated near-copy of `index.html`, differing only in title, `<h1>`,
favicon, `data-instrument`, and the switch link. A parity assertion normalises those and
requires the files to be otherwise identical — **edit `index.html`, then regenerate
`es.html`**, never hand-edit one alone.

**ES is web-only.** `analyze.py` and the chat-paste instruction below apply to crude only.
If the user starts pasting ES data in chat, that decision needs revisiting — `analyze.py`
would need a CSV-path argument.

Empty and small datasets: `computeAll()` returns `null` at N=0 and the page shows an empty
state; under 10 rows it shows a small-sample notice. Both exist because ES ships with no
history.

**The toolbar starts hidden.** The four controls (paste/edit, link CSV, download, reset)
carry `class="actions locked"` and only appear once a shortcut fires; the state is not
persisted, so every reload starts hidden again. The instrument switch link sits *outside*
that group and is always visible — navigation shouldn't require knowing the shortcut.
This is cosmetic tidying, **not access control**: the page and all its data remain public
to anyone with the URL.

`Ctrl+Q` (or `Ctrl+Shift+V`, or the Paste button) reveals the toolbar and opens a modal,
pre-fills from the clipboard where permitted, previews the parsed rows, and commits on
confirm. `Ctrl+Shift+E` opens it straight into edit mode; clicking any row in the data
table jumps to that row's line. All of these also reveal the toolbar.

**Two modes:** *Add data* appends/replaces by date. *Edit dataset* exposes the whole
dataset as editable CSV — change any value, delete a line to drop that day — with a diff
preview (added / modified / removed) before commit.

**Writing to disk.** Each page updates *its own* CSV in place via the File System Access
API. The user clicks *Link CSV file* once and picks the file; the handle is stored in that
instrument's IndexedDB database (`CFG.idb` → store `kv` → key `csvHandle`) and survives
reloads. On load, if a linked handle has permission, the page **reads the dataset from
that file**, so the CSV is the real source rather than a copy. `localStorage` (`CFG.store`)
is only a cache and offline fallback.

| Instrument | localStorage | IndexedDB | CSV |
|---|---|---|---|
| Crude | `clu26.rows.v1` | `clu26` | `clu26_price_history.csv` |
| Emini | `es.rows.v1` | `es` | `es_price_history.csv` |

Constraints worth remembering before promising anything here:
- **Chrome/Edge only.** Firefox and Safari have no File System Access API — those browsers
  fall back to *Download CSV*, and the page says so in a banner.
- Permission usually needs re-granting after a browser restart; the page detects this and
  shows a banner rather than silently failing to write.
- Every write goes through `toCSV()`, which round-trips byte-for-byte with the on-disk
  format (asserted in the parity test).

Redeploy with `vercel deploy --prod`. **Run `node web/parity.test.mjs` first** — the
algorithm exists in two languages and that test is what keeps them honest. If you change
`analyze.py`, change `algo.js` to match (and vice versa), then re-run it.

**Regenerate `web/es.html` after any edit to `index.html`** (verified to differ only in
title, `<h1>`, favicon, `data-instrument`, and the switch link):

```bash
node -e "
const fs=require('fs'); let h=fs.readFileSync('web/index.html','utf8');
h=h.replace('<title>Crude Oil Range Projector</title>','<title>Emini S&P 500 Range Projector</title>')
   .replace('<h1>Crude Oil Range Projector</h1>','<h1>Emini S&amp;P 500 Range Projector</h1>')
   .replace('data-instrument=\"cl\"','data-instrument=\"es\"')
   .replace(/(<text y='\.9em' font-size='90'>)[^<]*/, '\$1📈')
   .replace('href=\"/es\">Emini S&amp;P 500','href=\"/\">Crude Oil');
fs.writeFileSync('web/es.html',h);"
```

**Regenerate `web/seed.js` after editing the crude CSV**, or the unlinked baseline goes
stale (this command reproduces the current `seed.js` byte-for-byte):

```bash
node -e "
const fs=require('fs');
const lines=fs.readFileSync('clu26_price_history.csv','utf8').trim().split(/\r?\n/); lines.shift();
const rows=lines.map(l=>{const [d,o,h,lo,c,ch,p,v,oi]=l.split(',');const [mm,dd,yy]=d.split('/');
  const n=s=>(s===undefined||s.trim()==='')?null:Number(String(s).replace(/[,%]/g,''));
  return {date:d,key:yy+'-'+mm+'-'+dd,open:n(o),high:n(h),low:n(lo),close:n(c),change:n(ch),pct:n(p),vol:n(v),oi:n(oi)};});
fs.writeFileSync('web/seed.js','// Generated from clu26_price_history.csv -- do not hand-edit.\n// Baseline only: localStorage takes precedence once the user appends a day.\nexport const SEED = '+JSON.stringify(rows).replace(/\},\{/g,'},\n{')+';\n');"
```

### Site is public — do not claim otherwise

An attempt to lock the site with Vercel Authentication was made and **did not take
effect** on the URL that matters. `ssoProtection` is enabled but scoped to
`prod_deployment_urls_and_all_previews`, which covers `*-hash-team.vercel.app` deployment
URLs (they 302) but **not** the production alias `cl-high-low-range.vercel.app`, which
still serves the app to anyone (verified 200, real HTML).

Fixing it needs `deploymentType: "all"`, which the CLI cannot set — `vercel project
protection --sso` has no scope flag, and the MCP server 404s on this project. It requires
the dashboard (Settings → Deployment Protection → Vercel Authentication → All
Deployments) or a REST call with a token. The user declined for now and asked for the
hidden toolbar instead. Do not describe the site as protected.

### Keeping the stores reconciled

`clu26_price_history.csv` is the system of record. **If the CSV is linked in the browser,
the page writes to it directly and reads from it on load** — no divergence, nothing to
reconcile.

Divergence is only possible when the CSV is *not* linked (Firefox/Safari, permission
denied, or the user never clicked *Link CSV file*). In that case the page holds an
unsynced copy in `localStorage` and the user must *Download CSV* and replace the file.

- Data pasted **in chat** → append to the CSV (standing instruction below). If the user
  has the page open with the file linked, tell them to reload so it picks up the change.
- Data pasted **into the page** with the CSV linked → already on disk; nothing further.
- Data pasted **into the page** without linking → remind them to *Download CSV*.
- After editing the CSV outside the page, regenerate `web/seed.js` and redeploy only if
  the *unlinked* baseline should change; a linked user reads from disk and ignores the seed.
- If anything disagrees, the CSV wins.

## STANDING INSTRUCTION — when the user pastes new price data

Every time the user pastes one or more new dates **in chat**, do **both** steps, in order,
without being asked again:

1. **Append the row(s) to `clu26_price_history.csv`.**
2. **Re-run the calculation** (`python analyze.py`) and report the updated projection.

Pasting data is an implicit request for the full updated analysis. Never just append and
stop; never just calculate without persisting. If a paste is ambiguous or malformed, ask
before writing — do not guess at a value.

**Which instrument?** This instruction is written for crude. The user's stated intent is
that **Emini data goes into the web page, not chat.** If Emini rows do arrive in chat,
don't silently append them to the crude CSV — the prices are an order of magnitude apart,
so it would corrupt the dataset in a way the integrity checks won't catch (they verify
`High ≥ Low` per row, not that a row belongs). Confirm which instrument it is, and note
that `analyze.py` has no ES support yet: it would need a CSV-path argument, and
`es_price_history.csv` has no seed for `web/seed.js` to mirror.

### Appending rules

- **Sort order is load-bearing.** The file is oldest → newest, and row position *is* the
  weight (`W_i = i`). Insert new dates in date order. `analyze.py` re-sorts defensively,
  but keep the file correct on disk.
- **Format:** `MM/DD/YYYY`, thousands separators stripped from Volume/OpenInt
  (`214540`, not `214,540`). Keep the `+`/`-` sign on Change and %Change.
- **Missing cells stay empty.** Never zero-fill. A `0` volume is a fabricated value that
  silently corrupts later analysis. A row is kept as long as High, Low, and Close are all
  present; those three are all the algorithm consumes.
- **Duplicate date:** treat the newer paste as a revision — replace the existing row and
  say so in the response. Do not create a second row for the same date.
- **Never fabricate, interpolate, or fill a gap from memory.** If data is missing, say so.

## The algorithm

### Part 1: Linearly Weighted Historical Averages

For N days sorted oldest (`i=1`) to newest (`i=N`):

- `W_i = i`, so `ΣW = N(N+1)/2`
- `Weighted Avg High = Σ(High_i · W_i) / ΣW`
- `Weighted Avg Low  = Σ(Low_i · W_i) / ΣW`
- `WDR (Weighted Avg Daily Range) = Σ((High_i − Low_i) · W_i) / ΣW`
- `Weighted Avg Close = Σ(Close_i · W_i) / ΣW` — needed for the momentum test

### Part 2: Projection Model

Projection from the latest close:

- `Expected Low  = Close_latest − 0.5 · WDR`
- `Expected High = Close_latest + 0.5 · WDR`
- Pivot = `Close_latest`
- Momentum: bullish if `Close_latest > Weighted Avg Close`, bearish if below
- Validation: `span ≥ WDR`

**Momentum tilt is deliberately not applied numerically.** The spec says to bias the
range "slightly" but defines no coefficient. Inventing one would fabricate a parameter,
so the band stays symmetric and momentum is reported as direction only. If the user ever
supplies a coefficient, apply it and state the figure explicitly.

### Part 3: Market Structure (Pivot Points)

Using **only the most recent day's** `High`, `Low`, `Close`, calculate standard floor
pivots to identify structural support and resistance:

- `P  = (High_latest + Low_latest + Close_latest) / 3`
- `R1 = (2 · P) − Low_latest`
- `S1 = (2 · P) − High_latest`
- `R2 = P + (High_latest − Low_latest)`
- `S2 = P − (High_latest − Low_latest)`

Note this `P` is the *floor pivot* and is a different quantity from the Part 2 pivot
(`Close_latest`). Report both; do not conflate them.

### Part 4: Confluence Adjustment (The Final Range)

Compare the Part 2 Expected High/Low against the Part 3 pivots. Levels act as structural
magnets:

- If Expected High is very close to `R1` or `R2`, snap the final Expected High to it.
- If Expected Low is very close to `S1` or `S2`, snap the final Expected Low to it.
- When both candidates qualify, snap to the **nearest** one.

**"Very close" threshold — `SNAP_THRESHOLD`, currently `0.25 × WDR`. It is defined twice:
`analyze.py` and `web/algo.js`. Change both, or the parity test fails.**
The spec does not define the tolerance, and unlike the Part 2 momentum tilt this one
cannot be left unapplied without making Part 4 a no-op. So it is set explicitly rather
than silently: a quarter of the average daily range. This is a tuning knob, not a
derived constant — `analyze.py` prints a sensitivity table showing where each snap
decision flips, and **the report must disclose the threshold used and any snap that
fired.** Change the constant if the user prefers a tighter or looser magnet.

After snapping, re-check `span ≥ WDR`. Snapping can widen or narrow the band; if it
narrows it below WDR, report the violation rather than silently re-widening.

## Reporting

Show the arithmetic in a `<thinking>` block first, then emit the report wrapped in
`<analysis_report>` tags with these sections in this order:

```
## Extracted Historical Data
    Markdown table, sorted oldest -> newest:
    Date | Open | High | Low | Latest | Change | %Change | Volume | Open Int

## Time-Weighted Historical Analysis
    * Total Days Analyzed (N):        [count, plus first/last date]
    * Weighted Average High:          [2dp]
    * Weighted Average Low:           [2dp]
    * Weighted Average Daily Range:   [2dp]

## Today's Projected Price Range
    * Expected Low:                   [final, post-confluence]
    * Expected High:                  [final, post-confluence]
    * Expected Pivot / Center:        [Close_latest]
    * Key Pivot Levels:               [list P, R1, R2, S1, S2]
    * Confluence Notes:               [whether the projected high/low aligns with any
                                       major pivot support/resistance]
    * Confidence Level / Rationale:   [how momentum and weighted volatility shaped
                                       the boundary]

## Summary & Key Takeaways
    2-3 actionable insights: momentum, volatility trend, critical S/R levels.
```

Always state N and the first/last dates so the window is visible.

**Key Pivot Levels** — list all five from Part 3, high to low (`R2, R1, P, S1, S2`), so
the ladder reads top-down. Label `P` as the *floor pivot* to keep it distinct from the
Part 2 pivot (`Close_latest`), which appears one line above it.

**Confluence Notes** — state for each side whether a snap fired, which level, and the
pre-snap distance. Report distances, not just verdicts: a 0.08 gap and a 0.54 gap both
"snap" under the current threshold but carry very different conviction. Say plainly when
a snap is threshold-sensitive (would flip under a tighter tolerance) and when it is
robust. If no snap fires, say so — silence reads as though the question was skipped.

### Two caveats to keep repeating

1. **The `span ≥ WDR` validation is vacuous.** A symmetric `±0.5·WDR` band always equals
   WDR exactly. It catches arithmetic errors, nothing more — never present it as evidence
   the band is correctly sized.
2. **Check WDR against recent realized volatility.** `analyze.py` prints the last-10-day
   simple mean range and warns when it exceeds WDR by >15%. As of 07/30/2026 recent vol
   ran ~24% above WDR, meaning the band was too narrow. Surface this whenever it fires;
   the projected range is a high-probability core zone, not a hard boundary.

## Scope

Statistical range projection from historical OHLC only. No knowledge of the live session
or any scheduled catalyst — inventory reports and OPEC headlines for crude, CPI/FOMC and
earnings for the Emini. Not a trade recommendation — say so in the report.

## Data provenance

Barchart, pasted manually from the browser
(crude: `barchart.com/futures/quotes/CLU26/price-history/historical`).

**Barchart pages cannot be fetched** — the table renders client-side, so an HTTP fetch
returns an empty JS shell with unpopulated `[[ item.lastPrice ]]` placeholders. This was
tried and confirmed. Do not retry the URL expecting rows; ask the user to paste, or to
export CSV.

The paste format is **vertical**: one field per line, nine lines per day, thousands
separators intact. The parser handles that plus one-row-per-line CSV/TSV, and tolerates a
short record (the 04/30/2026 crude row has no Volume/OpenInt and must stay that way).
