import { SEED } from "./seed.js";

/**
 * One config per instrument. The page picks its own via <body data-instrument="…">.
 *
 * `store`, `idb` and `csv` MUST be unique across instruments — they are what keeps the
 * datasets isolated. Reusing one would make two instruments silently overwrite each
 * other's data. parity.test.mjs asserts uniqueness.
 */
export const INSTRUMENTS = {
  cl: {
    key: "cl",
    title: "Crude Oil Range Projector",
    store: "clu26.rows.v1",
    idb: "clu26",
    csv: "clu26_price_history.csv",
    seed: SEED,
    other: { label: "Emini S&P 500", href: "/es" },
  },
  es: {
    key: "es",
    title: "Emini S&P 500 Range Projector",
    store: "es.rows.v1",
    idb: "es",
    csv: "es_price_history.csv",
    seed: [],                       // no history yet — the user pastes it
    other: { label: "Crude Oil", href: "/" },
  },
};

export function getInstrument(key) {
  const cfg = INSTRUMENTS[key];
  if (!cfg) throw new Error(`Unknown instrument "${key}" — expected one of ${Object.keys(INSTRUMENTS).join(", ")}`);
  return cfg;
}
