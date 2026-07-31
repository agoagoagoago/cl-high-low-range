/**
 * CLU26 time-weighted range projection.
 *
 * Mirror of analyze.py. Any change here must keep parity.test.mjs passing --
 * that test is the only thing preventing this file and analyze.py from drifting.
 *
 * Imported by both app.js (browser) and parity.test.mjs (node).
 */

// Part 4 "very close" tolerance, as a multiple of WDR. Not derived from the spec --
// an explicit tuning knob. Must match SNAP_THRESHOLD in analyze.py.
export const SNAP_THRESHOLD = 0.25;

const DATE_RE = /(\d{1,2})\/(\d{1,2})\/(\d{4})/;
const FIELDS = ["open", "high", "low", "close", "change", "pct", "vol", "oi"];

/** "214,540" -> 214540 ; "+6.56%" -> 6.56 ; "" -> null */
function num(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/[,%\s]/g, "");
  if (s === "" || s === "-") return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function isoKey(mm, dd, yyyy) {
  return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/**
 * Parse Barchart's vertical paste format (one field per line, 9 lines per day).
 * Also tolerates one-row-per-line CSV / tab-separated.
 *
 * Returns { rows, errors }. Rows are NOT validated here beyond parseability --
 * validateRow() handles semantic checks so the UI can report them individually.
 */
export function parseInput(text) {
  const rows = [];
  const errors = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    // Need at least open/high/low/close positionally to be usable.
    if (cur.fields.length < 4) {
      errors.push(`${cur.date}: only ${cur.fields.length} field(s) after the date; need at least 4 (Open, High, Low, Last).`);
      cur = null;
      return;
    }
    const r = { date: cur.date, key: cur.key };
    FIELDS.forEach((f, i) => { r[f] = num(cur.fields[i]); });
    if (r.high == null || r.low == null || r.close == null) {
      errors.push(`${cur.date}: High, Low and Last must all be numeric.`);
      cur = null;
      return;
    }
    rows.push(r);
    cur = null;
  };

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^date\s*[,\t]/i.test(line)) continue;   // CSV header, not a record

    const m = line.match(DATE_RE);
    if (m) {
      flush();
      const date = `${String(m[1]).padStart(2, "0")}/${String(m[2]).padStart(2, "0")}/${m[3]}`;
      cur = { date, key: isoKey(m[1], m[2], m[3]), fields: [] };
      // Single-line record? Everything after the date on this line are its fields.
      const rest = line.slice(m.index + m[0].length).trim();
      if (rest) {
        cur.fields = rest.split(/[,\t]|\s{2,}/).map((s) => s.trim()).filter(Boolean);
        flush();
      }
      continue;
    }

    if (!cur) {
      errors.push(`Ignored line before any date: "${line.slice(0, 40)}"`);
      continue;
    }
    cur.fields.push(line);
  }
  flush();

  if (!rows.length && !errors.length) errors.push("No dated rows found. Expected MM/DD/YYYY.");
  return { rows, errors };
}

/** Semantic validation. Returns an array of human-readable problems (empty = ok). */
export function validateRow(r) {
  const bad = [];
  if (r.high < r.low) bad.push(`High ${r.high} is below Low ${r.low}`);
  if (r.close < r.low || r.close > r.high) {
    bad.push(`Last ${r.close} sits outside its own range [${r.low}, ${r.high}]`);
  }
  return bad;
}

/** Oldest -> newest. Row position IS the weight, so this ordering is load-bearing. */
export function sortRows(rows) {
  return [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Merge new rows into existing. Duplicate date replaces (CLAUDE.md rule).
 * Returns { rows, added, replaced }.
 */
export function mergeRows(existing, incoming) {
  const byKey = new Map(existing.map((r) => [r.key, r]));
  const added = [], replaced = [];
  for (const r of incoming) {
    if (byKey.has(r.key)) replaced.push(r.date); else added.push(r.date);
    byKey.set(r.key, r);
  }
  return { rows: sortRows([...byKey.values()]), added, replaced };
}

/** Part 1 weighted statistics. */
export function weighted(rows) {
  const N = rows.length;
  const W = (N * (N + 1)) / 2;
  const wa = (fn) => rows.reduce((acc, r, i) => acc + fn(r) * (i + 1), 0) / W;
  return {
    N, W,
    wah: wa((r) => r.high),
    wal: wa((r) => r.low),
    wdr: wa((r) => r.high - r.low),
    wac: wa((r) => r.close),
    close: rows[N - 1].close,
    latest: rows[N - 1],
  };
}

/** Part 3 floor pivots, from the most recent day only. */
export function pivots(row) {
  const { high: h, low: l, close: c } = row;
  const P = (h + l + c) / 3;
  return { P, R1: 2 * P - l, S1: 2 * P - h, R2: P + (h - l), S2: P - (h - l) };
}

/** Part 4 snap-to-nearest-within-tolerance. */
export function snap(value, levels, tol) {
  let name = null, lvl = null, dist = Infinity;
  for (const [k, v] of Object.entries(levels)) {
    const d = Math.abs(value - v);
    if (d < dist) { dist = d; name = k; lvl = v; }
  }
  return dist <= tol ? { value: lvl, name, dist } : { value, name: null, dist };
}

/** Integrity gates, mirroring analyze.py check(). */
export function integrity(rows, s) {
  const keys = rows.map((r) => r.key);
  const sorted = [...keys].sort();
  const hs = rows.map((r) => r.high), ls = rows.map((r) => r.low);
  const rg = rows.map((r) => r.high - r.low);
  const mn = (a) => Math.min(...a), mx = (a) => Math.max(...a);
  let direct = 0; for (let i = 1; i <= s.N; i++) direct += i;
  return [
    ["sorted oldest→newest", keys.every((k, i) => k === sorted[i])],
    ["no duplicate dates", new Set(keys).size === s.N],
    ["ΣW closed-form == direct", s.W === direct],
    ["WAH within High min/max", s.wah >= mn(hs) && s.wah <= mx(hs)],
    ["WAL within Low min/max", s.wal >= mn(ls) && s.wal <= mx(ls)],
    ["WDR within range min/max", s.wdr >= mn(rg) && s.wdr <= mx(rg)],
    ["WAH > WAL", s.wah > s.wal],
    ["WAH − WAL == WDR", Math.abs(s.wah - s.wal - s.wdr) < 1e-9],
    ["no High < Low", rows.every((r) => r.high >= r.low)],
    ["Last inside [Low, High]", rows.every((r) => r.close >= r.low && r.close <= r.high)],
  ];
}

/**
 * Full pipeline: Parts 1-4 plus checks. `rows` must already be sorted.
 * Returns null for an empty dataset -- a new instrument has no history until the user
 * pastes some, and every statistic below is undefined at N=0 (SumW would be 0).
 */
export function computeAll(rows, threshold = SNAP_THRESHOLD) {
  if (!rows || rows.length === 0) return null;
  const s = weighted(rows);
  const pv = pivots(s.latest);
  const half = 0.5 * s.wdr;
  const expLow = s.close - half;
  const expHigh = s.close + half;
  const tol = threshold * s.wdr;

  const hiSnap = snap(expHigh, { R1: pv.R1, R2: pv.R2 }, tol);
  const loSnap = snap(expLow, { S1: pv.S1, S2: pv.S2 }, tol);

  const sensitivity = [0.10, 0.15, 0.25, 0.40, 0.50].map((t) => ({
    t,
    tol: t * s.wdr,
    hi: snap(expHigh, { R1: pv.R1, R2: pv.R2 }, t * s.wdr),
    lo: snap(expLow, { S1: pv.S1, S2: pv.S2 }, t * s.wdr),
  }));

  const rg = rows.map((r) => r.high - r.low);
  const n10 = Math.min(10, s.N);
  const recentMean = rg.slice(-n10).reduce((a, b) => a + b, 0) / n10;

  return {
    ...s, pivots: pv, threshold, tol,
    expLow, expHigh,
    finalLow: loSnap.value, finalHigh: hiSnap.value,
    hiSnap, loSnap, sensitivity,
    momentum: s.close - s.wac,
    bullish: s.close > s.wac,
    spanOk: hiSnap.value - loSnap.value >= s.wdr - 1e-9,
    n10, recentMean,
    volWarning: recentMean > s.wdr * 1.15,
    checks: integrity(rows, s),
  };
}

/** Re-export to CSV in the exact on-disk format (empty cells stay empty). */
export function toCSV(rows) {
  const head = "Date,Open,High,Low,Last,Change,PctChange,Volume,OpenInt";
  const f2 = (v) => (v == null ? "" : v.toFixed(2));
  const sign = (v) => (v == null ? "" : (v > 0 ? "+" : "") + v.toFixed(2));
  const int = (v) => (v == null ? "" : String(Math.round(v)));
  const body = rows.map((r) =>
    [r.date, f2(r.open), f2(r.high), f2(r.low), f2(r.close),
     sign(r.change), r.pct == null ? "" : (r.pct > 0 ? "+" : "") + r.pct.toFixed(2) + "%",
     int(r.vol), int(r.oi)].join(",")
  );
  return [head, ...body].join("\n") + "\n";
}
