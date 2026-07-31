import { SEED } from "./seed.js";
import {
  parseInput, validateRow, sortRows, mergeRows, computeAll, toCSV, SNAP_THRESHOLD,
} from "./algo.js";

const STORE = "clu26.rows.v1";
const $ = (id) => document.getElementById(id);
const f2 = (v) => (v == null ? "—" : v.toFixed(2));

let rows = load();
let pending = null;   // { rows, added, replaced } awaiting commit

/* ---------------- persistence ---------------- */

function load() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return sortRows(SEED);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return sortRows(SEED);
    return sortRows(parsed);
  } catch {
    return sortRows(SEED);       // corrupt storage must never brick the page
  }
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(rows));
  } catch (e) {
    toast("Could not save to local storage — this session's changes are in memory only.", true);
  }
}

/* ---------------- toast ---------------- */

let toastTimer;
function toast(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6500 : 4000);
}

/* ---------------- modal ---------------- */

async function openModal() {
  const dlg = $("modal");
  if (dlg.open) return;
  $("paste-area").value = "";
  $("preview").hidden = true;
  $("btn-commit").disabled = true;
  pending = null;
  dlg.showModal();
  $("paste-area").focus();

  // Best effort: pre-fill from the clipboard. Needs HTTPS + permission; if it is
  // denied or unsupported the user just presses Ctrl+V, so no dead end either way.
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.trim()) {
      $("paste-area").value = text.trim();
      doPreview();
    }
  } catch { /* silent: manual paste is the expected fallback */ }
}

function doPreview() {
  const text = $("paste-area").value;
  const box = $("preview");
  if (!text.trim()) { box.hidden = true; $("btn-commit").disabled = true; return; }

  const { rows: parsed, errors } = parseInput(text);
  const bad = [];
  const good = [];
  for (const r of parsed) {
    const problems = validateRow(r);
    if (problems.length) bad.push(`${r.date}: ${problems.join("; ")}`);
    else good.push(r);
  }

  const existing = new Set(rows.map((r) => r.key));
  const parts = [];

  if (good.length) {
    parts.push("<h3>Will be added</h3>");
    for (const r of good) {
      const dup = existing.has(r.key);
      parts.push(
        `<div class="row${dup ? " rep" : ""}">${r.date} — O ${f2(r.open)}  H ${f2(r.high)}` +
        `  L ${f2(r.low)}  C ${f2(r.close)}${dup ? "  (replaces existing row)" : ""}</div>`
      );
    }
  }
  if (bad.length || errors.length) {
    parts.push("<h3>Rejected</h3>");
    for (const b of [...bad, ...errors]) parts.push(`<div class="row err">${esc(b)}</div>`);
  }

  box.innerHTML = parts.join("");
  box.hidden = false;
  pending = good.length ? good : null;
  $("btn-commit").disabled = !good.length;
}

function commit() {
  if (!pending) return;
  const res = mergeRows(rows, pending);
  rows = res.rows;
  save();
  render();
  $("modal").close();

  const bits = [];
  if (res.added.length) bits.push(`added ${res.added.join(", ")}`);
  if (res.replaced.length) bits.push(`replaced ${res.replaced.join(", ")}`);
  toast(`${bits.join(" · ")} — N is now ${rows.length}. Download CSV to sync the file on disk.`);
  pending = null;
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/* ---------------- render ---------------- */

function render() {
  const r = computeAll(rows);

  $("window-label").textContent =
    `N = ${r.N}  ·  ${rows[0].date} → ${rows[r.N - 1].date}  ·  ΣW = ${r.W}`;
  $("row-count").textContent = `${r.N} days`;

  // hero
  $("final-low").textContent = f2(r.finalLow);
  $("final-high").textContent = f2(r.finalHigh);
  $("pivot").textContent = f2(r.close);
  $("low-note").textContent = r.loSnap.name
    ? `snapped to ${r.loSnap.name} (was ${f2(r.expLow)})`
    : `${f2(r.expLow)} — no snap`;
  $("high-note").textContent = r.hiSnap.name
    ? `snapped to ${r.hiSnap.name} (was ${f2(r.expHigh)})`
    : `${f2(r.expHigh)} — no snap`;

  const dir = r.bullish ? "bullish" : "bearish";
  $("momentum").innerHTML =
    `Momentum is <b>${dir}</b> — the latest close of ${f2(r.close)} sits ` +
    `<b>${r.momentum >= 0 ? "+" : ""}${r.momentum.toFixed(2)}</b> against the weighted ` +
    `average close of ${f2(r.wac)}. Span ${(r.finalHigh - r.finalLow).toFixed(2)} ` +
    `vs WDR ${f2(r.wdr)}${r.spanOk ? "" : " — <b>below WDR, validation violated</b>"}.`;

  // pivots
  $("pivot-src").textContent =
    `From ${r.latest.date} only — H ${f2(r.latest.high)}, L ${f2(r.latest.low)}, C ${f2(r.latest.close)}.`;
  const order = [
    ["R2", r.pivots.R2, "res"], ["R1", r.pivots.R1, "res"],
    ["P", r.pivots.P, "piv"],
    ["S1", r.pivots.S1, "sup"], ["S2", r.pivots.S2, "sup"],
  ];
  $("pivot-table").innerHTML = order.map(([k, v, cls]) => {
    const hit = k === r.hiSnap.name || k === r.loSnap.name;
    return `<tr class="${cls}${hit ? " hit" : ""}"><td>${k}</td><td>${f2(v)}</td></tr>`;
  }).join("");

  // weighted stats
  $("stats-table").innerHTML = [
    ["Weighted Average High", f2(r.wah)],
    ["Weighted Average Low", f2(r.wal)],
    ["Weighted Avg Daily Range (WDR)", f2(r.wdr)],
    ["Weighted Average Close", f2(r.wac)],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");

  $("vol-check").innerHTML = r.volWarning
    ? `<strong>⚠ Recent volatility exceeds WDR.</strong> Last ${r.n10} days averaged a ` +
      `${r.recentMean.toFixed(2)} range versus WDR ${f2(r.wdr)} ` +
      `(${((r.recentMean / r.wdr - 1) * 100).toFixed(0)}% higher) — the projected band is ` +
      `likely too narrow. Treat it as a core zone, not a boundary.`
    : `Last ${r.n10} days averaged a ${r.recentMean.toFixed(2)} range versus WDR ` +
      `${f2(r.wdr)} — broadly consistent.`;

  // confluence
  const side = (label, s, expected) => s.name
    ? `<b>${label} snapped to ${s.name}</b> — was ${f2(expected)}, ${s.dist.toFixed(2)} away.`
    : `<b>${label} did not snap</b> — nearest level is ${s.dist.toFixed(2)} away, beyond the ${r.tol.toFixed(2)} tolerance.`;
  $("confluence-summary").innerHTML = `${side("High", r.hiSnap, r.expHigh)} ${side("Low", r.loSnap, r.expLow)}`;

  $("confluence-table").innerHTML = [
    ["Tolerance", `${r.threshold} × WDR = ${r.tol.toFixed(2)}`],
    ["Expected High (Part 2)", f2(r.expHigh)],
    ["→ distance to nearest R", r.hiSnap.dist.toFixed(2)],
    ["Expected Low (Part 2)", f2(r.expLow)],
    ["→ distance to nearest S", r.loSnap.dist.toFixed(2)],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");

  $("thr-label").textContent = `${SNAP_THRESHOLD} × WDR`;
  $("sensitivity-table").innerHTML = r.sensitivity.map((s) => {
    const cur = Math.abs(s.t - r.threshold) < 1e-9;
    return `<tr class="${cur ? "current" : ""}"><td>${s.t.toFixed(2)}×</td>` +
      `<td>(${s.tol.toFixed(2)})</td>` +
      `<td>${f2(s.lo.value)} ${s.lo.name || "none"}</td>` +
      `<td>${f2(s.hi.value)} ${s.hi.name || "none"}</td>` +
      `<td>${cur ? "← current" : ""}</td></tr>`;
  }).join("");

  // integrity
  $("checks").innerHTML = r.checks
    .map(([label, ok]) => `<li class="${ok ? "ok" : "bad"}">${label}</li>`).join("");

  // data table (newest first for reading, weight column keeps the real order visible)
  const head = "<thead><tr>" +
    ["W", "Date", "Open", "High", "Low", "Latest", "Change", "%Chg", "Volume", "Open Int"]
      .map((h) => `<th>${h}</th>`).join("") + "</tr></thead>";
  const body = rows.map((row, i) => {
    const w = i + 1;
    const cls = w === r.N ? "newest" : "";
    const dir = row.change == null ? "" : row.change >= 0 ? "up" : "down";
    const sgn = (v, suf = "") => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}${suf}`;
    const int = (v) => v == null ? "—" : v.toLocaleString("en-US");
    return `<tr class="${cls}"><td>${w}</td><td>${row.date}</td><td>${f2(row.open)}</td>` +
      `<td>${f2(row.high)}</td><td>${f2(row.low)}</td><td>${f2(row.close)}</td>` +
      `<td class="${dir}">${sgn(row.change)}</td><td class="${dir}">${sgn(row.pct, "%")}</td>` +
      `<td>${int(row.vol)}</td><td>${int(row.oi)}</td></tr>`;
  }).reverse().join("");
  $("data-table").innerHTML = head + `<tbody>${body}</tbody>`;
}

/* ---------------- actions ---------------- */

function downloadCSV() {
  const blob = new Blob([toCSV(rows)], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "clu26_price_history.csv";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("CSV exported — replace the file on disk to keep it the system of record.");
}

function reset() {
  if (!confirm(`Discard the local working copy (${rows.length} rows) and return to the ${SEED.length}-row baseline?`)) return;
  localStorage.removeItem(STORE);
  rows = sortRows(SEED);
  render();
  toast(`Reset to the ${rows.length}-row seed.`);
}

/* ---------------- wiring ---------------- */

document.addEventListener("keydown", (e) => {
  const q = e.key === "q" || e.key === "Q";
  const v = e.key === "v" || e.key === "V";
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && q) { e.preventDefault(); openModal(); }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && v) { e.preventDefault(); openModal(); }
});

$("btn-paste").addEventListener("click", openModal);
$("btn-csv").addEventListener("click", downloadCSV);
$("btn-reset").addEventListener("click", reset);
$("btn-check").addEventListener("click", doPreview);
$("btn-commit").addEventListener("click", commit);
$("btn-cancel").addEventListener("click", () => $("modal").close());
$("paste-area").addEventListener("input", () => {
  $("btn-commit").disabled = true;
  $("preview").hidden = true;
});
// Ctrl+Enter commits straight from the textarea
$("paste-area").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (pending) commit(); else doPreview();
  }
});

if (navigator.userAgent.includes("Firefox")) {
  const b = $("ff-banner");
  b.hidden = false;
  b.querySelector("[data-dismiss]").addEventListener("click", () => { b.hidden = true; });
}

render();
