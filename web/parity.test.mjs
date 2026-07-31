/**
 * Parity gate: asserts algo.js reproduces analyze.py exactly.
 *
 * The algorithm deliberately exists in two languages (Python for the chat workflow,
 * JS for the web page). This test is the ONLY thing stopping them from drifting.
 * Run it after touching either implementation:
 *
 *     node web/parity.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseInput, sortRows, computeAll, toCSV, validateRow, mergeRows } from "./algo.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSV = join(HERE, "..", "clu26_price_history.csv");

// Reference values produced by `python analyze.py` on the 63-row baseline.
const EXPECT = {
  N: 63, W: 2016,
  wah: 81.7323, wal: 78.0218, wdr: 3.7105, wac: 79.8383,
  close: 83.59,
  P: 84.1667, R1: 85.3633, R2: 87.1367, S1: 82.3933, S2: 81.1967,
  expLow: 81.7347, expHigh: 85.4453,
  finalLow: 81.1967, finalHigh: 85.3633,
  recentMean: 4.614,
};

let failures = 0;
const near = (a, b, eps = 5e-5) => Math.abs(a - b) < eps;

function check(label, actual, expected, eps) {
  const ok = typeof expected === "number" ? near(actual, expected, eps) : actual === expected;
  if (!ok) failures++;
  const shown = typeof actual === "number" ? actual.toFixed(4) : String(actual);
  const want = typeof expected === "number" ? expected.toFixed(4) : String(expected);
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label.padEnd(34)} ${shown}${ok ? "" : `   expected ${want}`}`);
}

// --- Load the CSV through the same parser the browser uses -------------------
const raw = readFileSync(CSV, "utf8").trim().split(/\r?\n/).slice(1).join("\n");
const { rows: parsed, errors } = parseInput(raw);
const rows = sortRows(parsed);

console.log("=== PARSE (CSV form) ===");
check("row count", rows.length, 63);
check("parse errors", errors.length, 0);
check("first date", rows[0].date, "04/30/2026");
check("last date", rows[62].date, "07/30/2026");
check("04/30 Volume stays empty", rows[0].vol, null);
check("04/30 OpenInt stays empty", rows[0].oi, null);
check("no semantic violations", rows.flatMap(validateRow).length, 0);

// --- Vertical Barchart paste format (the format actually used) ---------------
const vertical = `07/30/2026
84.65
85.94
82.97
83.59
-0.87
-1.03%
214,540
265,946`;
const v = parseInput(vertical);
console.log("\n=== PARSE (vertical Barchart form) ===");
check("vertical rows", v.rows.length, 1);
check("vertical errors", v.errors.length, 0);
check("vertical date", v.rows[0].date, "07/30/2026");
check("vertical high", v.rows[0].high, 85.94);
check("vertical low", v.rows[0].low, 82.97);
check("thousands separator stripped", v.rows[0].vol, 214540);
check("percent stripped", v.rows[0].pct, -1.03);

// short record (no volume / open int) must still parse
const short = parseInput("04/30/2026\n90.00\n91.45\n86.70\n88.78\n-0.08\n-0.09%");
check("short record parses", short.rows.length, 1);
check("short record vol is null", short.rows[0].vol, null);

// --- Part 1-4 parity ---------------------------------------------------------
const r = computeAll(rows);
console.log("\n=== PART 1: WEIGHTED STATS ===");
check("N", r.N, EXPECT.N);
check("SumW", r.W, EXPECT.W);
check("Weighted Avg High", r.wah, EXPECT.wah);
check("Weighted Avg Low", r.wal, EXPECT.wal);
check("WDR", r.wdr, EXPECT.wdr);
check("Weighted Avg Close", r.wac, EXPECT.wac);

console.log("\n=== PART 2: PROJECTION ===");
check("Close_latest", r.close, EXPECT.close);
check("Expected Low (pre-snap)", r.expLow, EXPECT.expLow);
check("Expected High (pre-snap)", r.expHigh, EXPECT.expHigh);
check("momentum is bullish", r.bullish, true);

console.log("\n=== PART 3: FLOOR PIVOTS ===");
check("P", r.pivots.P, EXPECT.P);
check("R1", r.pivots.R1, EXPECT.R1);
check("R2", r.pivots.R2, EXPECT.R2);
check("S1", r.pivots.S1, EXPECT.S1);
check("S2", r.pivots.S2, EXPECT.S2);

console.log("\n=== PART 4: CONFLUENCE ===");
check("snap tolerance", r.tol, 0.25 * EXPECT.wdr);
check("high snapped to R1", r.hiSnap.name, "R1");
check("low snapped to S2", r.loSnap.name, "S2");
check("final Low", r.finalLow, EXPECT.finalLow);
check("final High", r.finalHigh, EXPECT.finalHigh);
check("span >= WDR", r.spanOk, true);

console.log("\n=== CHECKS / VOL ===");
check("all integrity gates pass", r.checks.every(([, ok]) => ok), true);
check("integrity gate count", r.checks.length, 10);
check("last-10 mean range", r.recentMean, EXPECT.recentMean, 5e-4);
check("vol warning fires", r.volWarning, true);

// --- Round-trip: export must reproduce the source CSV byte-for-byte ----------
console.log("\n=== CSV ROUND-TRIP ===");
const original = readFileSync(CSV, "utf8").replace(/\r\n/g, "\n");
check("export matches source CSV", toCSV(rows) === original, true);

// --- Merge semantics ---------------------------------------------------------
console.log("\n=== MERGE ===");
const dup = parseInput("07/30/2026\n1\n99\n1\n50\n0\n0%").rows;
const m1 = mergeRows(rows, dup);
check("duplicate replaces, N unchanged", m1.rows.length, 63);
check("duplicate reported as replaced", m1.replaced[0], "07/30/2026");
const fresh = parseInput("07/31/2026\n83.50\n85.20\n82.10\n84.00\n+0.41\n+0.49%\n100,000\n260,000").rows;
const m2 = mergeRows(rows, fresh);
check("new date appends", m2.rows.length, 64);
check("new date sorts last", m2.rows[63].date, "07/31/2026");

console.log(failures ? `\n*** ${failures} PARITY FAILURE(S) ***` : "\nAll parity checks passed.");
process.exit(failures ? 1 : 0);
