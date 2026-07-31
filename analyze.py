"""
CLU26 time-weighted high/low range projection.

Reads clu26_price_history.csv, applies linear time weighting (W_i = i, oldest = 1),
and projects today's expected range. Run after adding any new rows:

    python analyze.py

Prints integrity checks first — if any FAIL, the numbers below it are not trustworthy.
"""
import csv, datetime, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CSV = os.path.join(HERE, "clu26_price_history.csv")

# Part 4 "very close" tolerance, as a multiple of WDR. Not derived from the spec --
# an explicit tuning knob. See CLAUDE.md Part 4. Sensitivity table printed at runtime.
SNAP_THRESHOLD = 0.25


def load(path=CSV):
    rows, dropped = [], []
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            try:
                h, lo, c = float(r["High"]), float(r["Low"]), float(r["Last"])
            except (ValueError, KeyError):
                dropped.append(r.get("Date", "?"))
                continue
            rows.append({
                "date": datetime.datetime.strptime(r["Date"], "%m/%d/%Y").date(),
                "raw": r["Date"], "open": r["Open"],
                "high": h, "low": lo, "close": c,
                "vol": r["Volume"] or None, "oi": r["OpenInt"] or None,
            })
    rows.sort(key=lambda x: x["date"])   # oldest -> newest; row order IS the weight
    return rows, dropped


def analyze(rows):
    N = len(rows)
    W = N * (N + 1) // 2
    wa = lambda f: sum(f(r) * i for i, r in enumerate(rows, 1)) / W
    return {
        "N": N, "W": W,
        "wah": wa(lambda r: r["high"]),
        "wal": wa(lambda r: r["low"]),
        "wdr": wa(lambda r: r["high"] - r["low"]),
        "wac": wa(lambda r: r["close"]),
        "close": rows[-1]["close"],
    }


def pivots(row):
    """Part 3: standard floor pivots from the most recent day only."""
    h, l, c = row["high"], row["low"], row["close"]
    p = (h + l + c) / 3
    return {"P": p, "R1": 2 * p - l, "S1": 2 * p - h,
            "R2": p + (h - l), "S2": p - (h - l)}


def snap(value, levels, tol):
    """Part 4: snap to nearest level within tol. Returns (final, name, distance)."""
    best = min(levels.items(), key=lambda kv: abs(value - kv[1]))
    name, lvl = best
    dist = abs(value - lvl)
    return (lvl, name, dist) if dist <= tol else (value, None, dist)


def check(rows, s):
    """Integrity gates. Returns list of (label, passed)."""
    N, out = s["N"], []
    hs = [r["high"] for r in rows]
    ls = [r["low"] for r in rows]
    rg = [r["high"] - r["low"] for r in rows]
    dates = [r["date"] for r in rows]
    out.append(("sorted oldest->newest", dates == sorted(dates)))
    out.append(("no duplicate dates", len(set(dates)) == N))
    out.append(("SumW closed-form == direct", s["W"] == sum(range(1, N + 1))))
    out.append(("WAH within High min/max", min(hs) <= s["wah"] <= max(hs)))
    out.append(("WAL within Low min/max", min(ls) <= s["wal"] <= max(ls)))
    out.append(("WDR within range min/max", min(rg) <= s["wdr"] <= max(rg)))
    out.append(("WAH > WAL", s["wah"] > s["wal"]))
    out.append(("WAH - WAL == WDR", abs((s["wah"] - s["wal"]) - s["wdr"]) < 1e-9))
    out.append(("no High < Low", all(r["high"] >= r["low"] for r in rows)))
    out.append(("Close inside [Low,High]",
                all(r["low"] <= r["close"] <= r["high"] for r in rows)))
    return out


def main():
    rows, dropped = load()
    if not rows:
        sys.exit("No usable rows in clu26_price_history.csv")
    s = analyze(rows)
    rg = [r["high"] - r["low"] for r in rows]

    print(f"=== WINDOW ===\nN = {s['N']}  ({rows[0]['raw']} -> {rows[-1]['raw']})  SumW = {s['W']}")
    if dropped:
        print("DROPPED (missing H/L/C):", dropped)
    gaps = [r["raw"] for r in rows if r["vol"] is None or r["oi"] is None]
    if gaps:
        print("Missing Volume/OpenInt (row kept):", gaps)

    print("\n=== INTEGRITY ===")
    failed = 0
    for label, ok in check(rows, s):
        print(f"  [{'PASS' if ok else 'FAIL'}] {label}")
        failed += not ok

    print("\n=== WEIGHTED STATS ===")
    print(f"  Weighted Avg High  : {s['wah']:.2f}")
    print(f"  Weighted Avg Low   : {s['wal']:.2f}")
    print(f"  Weighted Avg Range : {s['wdr']:.2f}   <- WDR")
    print(f"  Weighted Avg Close : {s['wac']:.2f}")

    diff = s["close"] - s["wac"]
    half = 0.5 * s["wdr"]
    lo, hi = s["close"] - half, s["close"] + half
    print("\n=== PROJECTION ===")
    print(f"  Close_latest : {s['close']:.2f}  ({rows[-1]['raw']})")
    print(f"  vs WAC       : {diff:+.2f}  -> {'BULLISH' if diff > 0 else 'BEARISH'}")
    print(f"  Expected Low : {lo:.2f}")
    print(f"  Expected High: {hi:.2f}")
    print(f"  Span {hi - lo:.2f} >= WDR {s['wdr']:.2f}: {hi - lo >= s['wdr'] - 1e-9}"
          "  (true by construction - not an independent check)")

    pv = pivots(rows[-1])
    print(f"\n=== PART 3: FLOOR PIVOTS ({rows[-1]['raw']}) ===")
    print(f"  H={rows[-1]['high']:.2f}  L={rows[-1]['low']:.2f}  C={rows[-1]['close']:.2f}")
    for k in ("R2", "R1", "P", "S1", "S2"):
        print(f"  {k:>2} : {pv[k]:.2f}")

    tol = SNAP_THRESHOLD * s["wdr"]
    fhi, rname, rdist = snap(hi, {k: pv[k] for k in ("R1", "R2")}, tol)
    flo, sname, sdist = snap(lo, {k: pv[k] for k in ("S1", "S2")}, tol)
    print(f"\n=== PART 4: CONFLUENCE ADJUSTMENT ===")
    print(f"  threshold: {SNAP_THRESHOLD} x WDR = {tol:.2f}")
    print(f"  High {hi:.2f} -> nearest R at {rdist:.2f} : "
          + (f"SNAP to {rname} {fhi:.2f}" if rname else "no snap"))
    print(f"  Low  {lo:.2f} -> nearest S at {sdist:.2f} : "
          + (f"SNAP to {sname} {flo:.2f}" if sname else "no snap"))
    print(f"  FINAL RANGE: {flo:.2f} - {fhi:.2f}   (span {fhi - flo:.2f})")
    if fhi - flo < s["wdr"] - 1e-9:
        print(f"  WARNING: post-snap span {fhi - flo:.2f} < WDR {s['wdr']:.2f} "
              "- validation violated, reporting as-is (not silently re-widened).")

    print("  sensitivity (threshold -> high/low outcome):")
    for t in (0.10, 0.15, 0.25, 0.40, 0.50):
        a, an, _ = snap(hi, {k: pv[k] for k in ("R1", "R2")}, t * s["wdr"])
        b, bn, _ = snap(lo, {k: pv[k] for k in ("S1", "S2")}, t * s["wdr"])
        mark = " <-- current" if t == SNAP_THRESHOLD else ""
        print(f"    {t:.2f}x ({t * s['wdr']:.2f}): "
              f"{b:.2f} ({bn or 'none'}) - {a:.2f} ({an or 'none'}){mark}")

    n10 = min(10, s["N"])
    recent = sum(rg[-n10:]) / n10
    print("\n=== VOLATILITY REALITY CHECK (not part of spec) ===")
    print(f"  last {n10} simple mean range: {recent:.2f}  vs WDR {s['wdr']:.2f}"
          f"  ({(recent / s['wdr'] - 1) * 100:+.0f}%)")
    if recent > s["wdr"] * 1.15:
        print("  WARNING: recent realized vol materially exceeds WDR - band likely too narrow.")

    if failed:
        print(f"\n*** {failed} INTEGRITY CHECK(S) FAILED - do not trust the above. ***")
        sys.exit(1)


if __name__ == "__main__":
    main()
