import { getInstrument } from "./instruments.js";
import {
  parseInput, validateRow, sortRows, mergeRows, computeAll, toCSV, SNAP_THRESHOLD,
} from "./algo.js";

// Which instrument this page is. Everything storage-related keys off this, so the two
// pages never touch each other's data.
const CFG = getInstrument(document.body.dataset.instrument);
const SEED = CFG.seed;
const STORE = CFG.store;

const $ = (id) => document.getElementById(id);
const f2 = (v) => (v == null ? "—" : v.toFixed(2));
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const CAN_FS = typeof window.showOpenFilePicker === "function";

let rows = [];
let pending = null;     // rows awaiting commit (add mode) or full replacement (edit mode)
let mode = "add";       // "add" | "edit"
let fileHandle = null;  // FileSystemFileHandle for clu26_price_history.csv

/* ============================================================ *
 * IndexedDB — the only place a FileSystemFileHandle survives a
 * reload (it is structured-cloneable but not JSON-serialisable).
 * ============================================================ */

const idb = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(CFG.idb, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async get(key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction("kv", "readonly").objectStore("kv").get(key);
      t.onsuccess = () => res(t.result);
      t.onerror = () => rej(t.error);
    });
  },
  async set(key, val) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction("kv", "readwrite").objectStore("kv").put(val, key);
      t.onsuccess = () => res();
      t.onerror = () => rej(t.error);
    });
  },
  async del(key) {
    const db = await this.open();
    return new Promise((res) => {
      db.transaction("kv", "readwrite").objectStore("kv").delete(key).onsuccess = () => res();
    });
  },
};

/* ============================================================ *
 * CSV file on disk
 * ============================================================ */

async function hasPermission(handle, request = false) {
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if (!request) return false;
  return (await handle.requestPermission(opts)) === "granted";
}

/** Pick the CSV once; the handle is remembered across sessions. */
async function linkCSV() {
  if (!CAN_FS) {
    toast("This browser can't write files directly. Chrome or Edge required — use Download CSV instead.", true);
    return;
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "CSV", accept: { "text/csv": [".csv"] } }],
      multiple: false,
    });
    if (!(await hasPermission(handle, true))) {
      toast("Write permission denied — the file will not be updated.", true);
      return;
    }
    fileHandle = handle;
    await idb.set("csvHandle", handle);

    // The file on disk is the system of record: adopt its contents.
    const text = await (await handle.getFile()).text();
    const { rows: parsed, errors } = parseInput(text);
    if (parsed.length) {
      rows = sortRows(parsed);
      saveLocal();
      render();
      toast(`Linked ${handle.name} — loaded ${rows.length} rows from disk. Pastes now write straight to it.`);
    } else {
      toast(`Linked ${handle.name}, but no rows parsed from it${errors.length ? `: ${errors[0]}` : "."}`, true);
    }
    updateFsUI();
  } catch (e) {
    if (e?.name !== "AbortError") toast(`Could not link file: ${e.message}`, true);
  }
}

/** Write the dataset to the linked CSV. Returns true if it reached disk. */
async function writeCSV() {
  if (!fileHandle) return false;
  try {
    if (!(await hasPermission(fileHandle, true))) return false;
    const w = await fileHandle.createWritable();
    await w.write(toCSV(rows));
    await w.close();
    return true;
  } catch (e) {
    toast(`Could not write the CSV: ${e.message}`, true);
    return false;
  }
}

/** Re-attach a previously granted handle on startup, without prompting. */
async function restoreHandle() {
  if (!CAN_FS) return null;
  try {
    const handle = await idb.get("csvHandle");
    if (handle && (await hasPermission(handle))) return handle;
    return handle || null;   // kept, but needs a click to re-grant
  } catch { return null; }
}

function updateFsUI() {
  const btn = $("btn-link");
  const tgt = $("write-target");
  if (fileHandle) {
    btn.textContent = `CSV linked: ${fileHandle.name}`;
    btn.classList.add("ghost");
    tgt.textContent = `→ writes to ${fileHandle.name}`;
    tgt.classList.add("linked");
  } else {
    btn.textContent = "Link CSV file";
    btn.classList.remove("ghost");
    tgt.textContent = CAN_FS ? "→ not linked; changes stay in the browser" : "→ browser storage only";
    tgt.classList.remove("linked");
  }
}

/* ============================================================ *
 * Local persistence (cache / fallback)
 * ============================================================ */

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return sortRows(SEED);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? sortRows(parsed) : sortRows(SEED);
  } catch {
    return sortRows(SEED);
  }
}

function saveLocal() {
  try { localStorage.setItem(STORE, JSON.stringify(rows)); }
  catch { toast("Could not cache to local storage.", true); }
}

/** Persist everywhere, then re-render. */
async function persist(summary) {
  saveLocal();
  render();
  const wrote = await writeCSV();
  toast(wrote
    ? `${summary} — N is now ${rows.length}. Written to ${fileHandle.name}.`
    : `${summary} — N is now ${rows.length}. ${fileHandle
        ? "NOT written to disk (permission denied)."
        : "Browser only — link the CSV or use Download CSV."}`,
    !wrote && !!fileHandle);
}

/* ============================================================ *
 * Toast
 * ============================================================ */

let toastTimer;
function toast(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 7000 : 4500);
}

/* ============================================================ *
 * Modal
 * ============================================================ */

function setMode(next) {
  mode = next;
  $("tab-add").classList.toggle("active", next === "add");
  $("tab-edit").classList.toggle("active", next === "edit");
  $("pane-add").hidden = next !== "add";
  $("pane-edit").hidden = next !== "edit";
  $("btn-commit").textContent = next === "add" ? "Add to dataset" : "Replace dataset";
  $("preview").hidden = true;
  $("btn-commit").disabled = true;
  pending = null;
  if (next === "edit") {
    $("edit-area").value = toCSV(rows).trimEnd();
    $("edit-area").focus();
  } else {
    $("paste-area").focus();
  }
}

async function openModal(startMode = "add") {
  const dlg = $("modal");
  if (dlg.open) return;
  $("paste-area").value = "";
  updateFsUI();
  dlg.showModal();
  setMode(startMode);

  if (startMode !== "add") return;
  // Best effort clipboard pre-fill; manual Ctrl+V is the expected fallback.
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.trim() && mode === "add") {
      $("paste-area").value = text.trim();
      doPreview();
    }
  } catch { /* permission denied or unsupported — fine */ }
}

function doPreview() {
  const box = $("preview");
  const text = mode === "add" ? $("paste-area").value : $("edit-area").value;
  if (!text.trim()) {
    box.innerHTML = mode === "edit"
      ? `<h3>Rejected</h3><div class="row err">The dataset cannot be emptied.</div>`
      : "";
    box.hidden = mode === "add";
    $("btn-commit").disabled = true;
    return;
  }

  const { rows: parsed, errors } = parseInput(text);
  const good = [], bad = [];
  for (const r of parsed) {
    const problems = validateRow(r);
    if (problems.length) bad.push(`${r.date}: ${problems.join("; ")}`);
    else good.push(r);
  }

  // duplicate dates inside one edit payload would silently collapse — surface it
  const seen = new Set(), dupes = new Set();
  for (const r of good) { if (seen.has(r.key)) dupes.add(r.date); seen.add(r.key); }

  const existing = new Set(rows.map((r) => r.key));
  const parts = [];

  if (mode === "add" && good.length) {
    parts.push("<h3>Will be added</h3>");
    for (const r of good) {
      const dup = existing.has(r.key);
      parts.push(`<div class="row${dup ? " rep" : ""}">${r.date} — O ${f2(r.open)}  H ${f2(r.high)}` +
        `  L ${f2(r.low)}  C ${f2(r.close)}${dup ? "  (replaces existing row)" : ""}</div>`);
    }
  }

  if (mode === "edit" && good.length) {
    const removed = rows.filter((r) => !seen.has(r.key)).map((r) => r.date);
    const added = good.filter((r) => !existing.has(r.key)).map((r) => r.date);
    const changed = good.filter((r) => {
      const old = rows.find((x) => x.key === r.key);
      return old && ["open", "high", "low", "close", "change", "pct", "vol", "oi"]
        .some((f) => old[f] !== r[f]);
    }).map((r) => r.date);

    parts.push("<h3>Result</h3>");
    parts.push(`<div class="row">${rows.length} rows → <strong>${good.length} rows</strong></div>`);
    if (added.length) parts.push(`<div class="row">added: ${added.join(", ")}</div>`);
    if (changed.length) parts.push(`<div class="row rep">modified: ${changed.join(", ")}</div>`);
    if (removed.length) parts.push(`<div class="row err">removed: ${removed.join(", ")}</div>`);
    if (!added.length && !changed.length && !removed.length) {
      parts.push(`<div class="row">no changes</div>`);
    }
  }

  const problems = [...bad, ...errors];
  if (dupes.size) problems.push(`Duplicate date(s) in this input: ${[...dupes].join(", ")} — only the last would survive.`);
  if (mode === "edit" && !good.length) problems.push("Nothing valid to commit; the dataset cannot be emptied.");

  if (problems.length) {
    parts.push("<h3>Rejected</h3>");
    for (const p of problems) parts.push(`<div class="row err">${esc(p)}</div>`);
  }

  box.innerHTML = parts.join("");
  box.hidden = false;

  const ok = good.length > 0 && !dupes.size && (mode === "add" ? true : good.length > 0);
  pending = ok ? good : null;
  $("btn-commit").disabled = !ok;
}

async function commit() {
  if (!pending) return;
  let summary;
  if (mode === "add") {
    const res = mergeRows(rows, pending);
    rows = res.rows;
    const bits = [];
    if (res.added.length) bits.push(`added ${res.added.join(", ")}`);
    if (res.replaced.length) bits.push(`replaced ${res.replaced.join(", ")}`);
    summary = bits.join(" · ");
  } else {
    const before = rows.length;
    rows = sortRows(pending);
    summary = `dataset replaced (${before} → ${rows.length} rows)`;
  }
  pending = null;
  $("modal").close();
  await persist(summary);
}

/* ============================================================ *
 * Render
 * ============================================================ */

function render() {
  const r = computeAll(rows);

  // No history yet (a fresh instrument). Every statistic is undefined at N=0, so show
  // the empty state rather than a screen of NaNs.
  const empty = r === null;
  $("empty-state").hidden = !empty;
  for (const el of document.querySelectorAll("main > .card, main > .grid, main > .disclaimer")) {
    el.hidden = empty;
  }
  if (empty) {
    $("window-label").textContent = "no data yet";
    $("row-count").textContent = "0 days";
    return;
  }

  // Linear weighting over a handful of days says very little; don't dress it up.
  const small = $("small-sample");
  small.hidden = r.N >= 10;
  if (r.N < 10) {
    small.innerHTML = `<strong>Only ${r.N} day${r.N === 1 ? "" : "s"} of history.</strong> ` +
      `The weighted averages and the pivot-based range are computed correctly, but a ` +
      `sample this small carries little information — the newest day alone holds ` +
      `${((r.N / r.W) * 100).toFixed(0)}% of the total weight. Treat the projection as ` +
      `indicative until roughly 20+ days have accumulated.`;
  }

  $("window-label").textContent =
    `N = ${r.N}  ·  ${rows[0].date} → ${rows[r.N - 1].date}  ·  ΣW = ${r.W}`;
  $("row-count").textContent = `${r.N} days`;

  $("final-low").textContent = f2(r.finalLow);
  $("final-high").textContent = f2(r.finalHigh);
  $("pivot").textContent = f2(r.close);
  $("low-note").textContent = r.loSnap.name
    ? `snapped to ${r.loSnap.name} (was ${f2(r.expLow)})`
    : `${f2(r.expLow)} — no snap`;
  $("high-note").textContent = r.hiSnap.name
    ? `snapped to ${r.hiSnap.name} (was ${f2(r.expHigh)})`
    : `${f2(r.expHigh)} — no snap`;

  $("momentum").innerHTML =
    `Momentum is <b>${r.bullish ? "bullish" : "bearish"}</b> — the latest close of ` +
    `${f2(r.close)} sits <b>${r.momentum >= 0 ? "+" : ""}${r.momentum.toFixed(2)}</b> ` +
    `against the weighted average close of ${f2(r.wac)}. Span ` +
    `${(r.finalHigh - r.finalLow).toFixed(2)} vs WDR ${f2(r.wdr)}` +
    `${r.spanOk ? "" : " — <b>below WDR, validation violated</b>"}.`;

  $("pivot-src").textContent =
    `From ${r.latest.date} only — H ${f2(r.latest.high)}, L ${f2(r.latest.low)}, C ${f2(r.latest.close)}.`;
  $("pivot-table").innerHTML = [
    ["R2", r.pivots.R2, "res"], ["R1", r.pivots.R1, "res"],
    ["P", r.pivots.P, "piv"],
    ["S1", r.pivots.S1, "sup"], ["S2", r.pivots.S2, "sup"],
  ].map(([k, v, cls]) => {
    const hit = k === r.hiSnap.name || k === r.loSnap.name;
    return `<tr class="${cls}${hit ? " hit" : ""}"><td>${k}</td><td>${f2(v)}</td></tr>`;
  }).join("");

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
      `<td>(${s.tol.toFixed(2)})</td><td>${f2(s.lo.value)} ${s.lo.name || "none"}</td>` +
      `<td>${f2(s.hi.value)} ${s.hi.name || "none"}</td><td>${cur ? "← current" : ""}</td></tr>`;
  }).join("");

  $("checks").innerHTML = r.checks
    .map(([label, ok]) => `<li class="${ok ? "ok" : "bad"}">${label}</li>`).join("");

  const head = "<thead><tr>" +
    ["W", "Date", "Open", "High", "Low", "Latest", "Change", "%Chg", "Volume", "Open Int"]
      .map((h) => `<th>${h}</th>`).join("") + "</tr></thead>";
  const body = rows.map((row, i) => {
    const w = i + 1;
    const dir = row.change == null ? "" : row.change >= 0 ? "up" : "down";
    const sgn = (v, suf = "") => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}${suf}`;
    const int = (v) => v == null ? "—" : v.toLocaleString("en-US");
    return `<tr class="${w === r.N ? "newest" : ""}"><td>${w}</td><td>${row.date}</td>` +
      `<td>${f2(row.open)}</td><td>${f2(row.high)}</td><td>${f2(row.low)}</td>` +
      `<td>${f2(row.close)}</td><td class="${dir}">${sgn(row.change)}</td>` +
      `<td class="${dir}">${sgn(row.pct, "%")}</td><td>${int(row.vol)}</td><td>${int(row.oi)}</td></tr>`;
  }).reverse().join("");
  $("data-table").innerHTML = head + `<tbody>${body}</tbody>`;
}

/* ============================================================ *
 * Actions
 * ============================================================ */

function downloadCSV() {
  const blob = new Blob([toCSV(rows)], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = CFG.csv;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("CSV exported to your Downloads folder.");
}

async function reset() {
  const target = SEED.length ? `return to the ${SEED.length}-row baseline` : "clear all data";
  if (!confirm(`Discard the working copy (${rows.length} rows) and ${target}?` +
    (fileHandle ? `\n\nThis also OVERWRITES ${fileHandle.name} on disk.` : ""))) return;
  localStorage.removeItem(STORE);
  rows = sortRows(SEED);
  await persist(SEED.length ? `reset to the ${rows.length}-row seed` : "cleared all data");
}

/* ============================================================ *
 * Wiring
 * ============================================================ */

/** The toolbar is hidden until a shortcut reveals it, and re-hides on reload. */
function revealActions() {
  $("actions").classList.remove("locked");
}

document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const hit = (k) => e.key === k || e.key === k.toUpperCase();
  if (mod && !e.shiftKey && hit("q")) { e.preventDefault(); revealActions(); openModal("add"); }
  if (mod && e.shiftKey && hit("v")) { e.preventDefault(); revealActions(); openModal("add"); }
  if (mod && e.shiftKey && hit("e")) { e.preventDefault(); revealActions(); openModal("edit"); }
});

$("btn-paste").addEventListener("click", () => openModal("add"));
$("btn-link").addEventListener("click", linkCSV);
$("btn-csv").addEventListener("click", downloadCSV);
$("btn-reset").addEventListener("click", reset);
$("btn-check").addEventListener("click", doPreview);
$("btn-commit").addEventListener("click", commit);
$("btn-cancel").addEventListener("click", () => $("modal").close());
$("tab-add").addEventListener("click", () => setMode("add"));
$("tab-edit").addEventListener("click", () => setMode("edit"));

for (const id of ["paste-area", "edit-area"]) {
  $(id).addEventListener("input", () => {
    $("btn-commit").disabled = true;
    $("preview").hidden = true;
  });
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (pending) commit(); else doPreview();
    }
  });
}

// click a row in the data table to jump into edit mode with that line selected
document.addEventListener("click", (e) => {
  const tr = e.target.closest?.("#data-table tbody tr");
  if (!tr) return;
  const date = tr.children[1]?.textContent;
  revealActions();
  openModal("edit").then(() => {
    const ta = $("edit-area");
    const at = ta.value.indexOf(date);
    if (at < 0) return;
    const end = ta.value.indexOf("\n", at);
    ta.focus();
    ta.setSelectionRange(at, end < 0 ? ta.value.length : end);
  });
});

if (navigator.userAgent.includes("Firefox")) {
  const b = $("ff-banner");
  b.hidden = false;
  b.querySelector("[data-dismiss]").addEventListener("click", () => { b.hidden = true; });
}

/* ---------------- boot ---------------- */

(async function boot() {
  // Navigation and labels come from the instrument config, so the two pages' markup
  // stays identical apart from the title.
  const sw = $("switch-link");
  sw.href = CFG.other.href;
  sw.innerHTML = `${esc(CFG.other.label)} &rarr;`;
  $("btn-reset").textContent = SEED.length ? "Reset to seed" : "Clear data";

  rows = loadLocal();
  render();

  const handle = await restoreHandle();
  if (handle) {
    fileHandle = handle;
    if (await hasPermission(handle)) {
      try {
        const text = await (await handle.getFile()).text();
        const { rows: parsed } = parseInput(text);
        if (parsed.length) { rows = sortRows(parsed); saveLocal(); render(); }
      } catch { /* file moved or deleted; keep the cached copy */ }
    } else {
      const b = $("fs-banner");
      $("fs-msg").innerHTML =
        `<strong>${esc(handle.name)}</strong> is linked but needs permission again after a browser restart — ` +
        `press <kbd>Ctrl</kbd>+<kbd>Q</kbd>, then click <em>CSV linked</em> to re-grant, ` +
        `or changes stay in the browser.`;
      b.hidden = false;
      b.querySelector("[data-dismiss]").addEventListener("click", () => { b.hidden = true; });
    }
  } else if (!CAN_FS) {
    const b = $("fs-banner");
    $("fs-msg").innerHTML =
      `This browser cannot write files directly — <strong>Chrome or Edge</strong> is needed to ` +
      `update <code>${esc(CFG.csv)}</code> in place. Everything else works; use ` +
      `<em>Download CSV</em> to save changes.`;
    b.hidden = false;
    b.querySelector("[data-dismiss]").addEventListener("click", () => { b.hidden = true; });
  }
  updateFsUI();
})();
