import { ENGAGEMENT_WEIGHTS, TREND_HALF_LIFE_MS, type EngagementKind } from "../shared/constants.ts";

export interface Score {
  value: number;
  at: number;
}

/** Current value of a score that halves every TREND_HALF_LIFE_MS. Reading before `at` never inflates it. */
export function decayedScore(score: Score, now: number): number {
  const elapsed = Math.max(0, now - score.at);
  return score.value * 2 ** (-elapsed / TREND_HALF_LIFE_MS);
}

export function addEngagement(score: Score, kind: EngagementKind, now: number): Score {
  return { value: decayedScore(score, now) + ENGAGEMENT_WEIGHTS[kind], at: now };
}

/**
 * Time-invariant sort key. With one shared half-life H, value·2^(−(now−at)/H) ranks the same as
 * log2(value) + at/H at every instant, so an index on this key orders Trending without recomputation.
 */
export function trendKey(score: Score): number {
  return score.value > 0 ? Math.log2(score.value) + score.at / TREND_HALF_LIFE_MS : -1e9;
}

/** Authors earn the reply bonus only once someone else has replied, so a monologue cannot trend. */
export function replyEngagement(actorIsAuthor: boolean, othersHaveReplied: boolean): EngagementKind | null {
  if (!actorIsAuthor) return "reply";
  return othersHaveReplied ? "author_reply" : null;
}
