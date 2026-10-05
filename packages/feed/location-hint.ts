import { cellCenter } from "../geo/index.ts";

/** A subset of Cloudflare's Durable Object location hints. */
export type LocationHint = "wnam" | "enam" | "sam" | "weur" | "eeur" | "apac" | "oc" | "afr" | "me";

/**
 * Coarse continent boxes. A Durable Object created with a hint lives near its users,
 * which keeps a local product's data local. Wrong guesses only cost latency.
 */
export function locationHintFor(cell: string): LocationHint {
  const { latitude, longitude } = cellCenter(cell);
  if (longitude < -30) {
    if (latitude < 13) return "sam";
    return longitude < -100 ? "wnam" : "enam";
  }
  if (longitude < 60) {
    if (latitude < 35) return longitude > 34 && latitude > 12 ? "me" : "afr";
    return longitude < 20 ? "weur" : "eeur";
  }
  return latitude < -10 ? "oc" : "apac";
}
