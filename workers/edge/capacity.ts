import type { Env } from "./env.ts";

/**
 * Daily allowances of the Workers Free plan; they reset at 00:00 UTC and fail hard when spent. A cron reads
 * today's usage from the GraphQL Analytics API and pauses the API once any of them is nearly spent, so
 * people see a clear "resting" screen instead of half-working requests.
 */
export const FREE_DAILY_LIMITS = { workers: 100_000, durableObjects: 100_000, queues: 10_000 } as const;
export const PAUSE_AT_FRACTION = 0.9;

export type CapacityResource = keyof typeof FREE_DAILY_LIMITS;
export type DailyUsage = Record<CapacityResource, number>;

export interface CapacityState {
  paused: boolean;
  /** The allowance that ran out, when paused. */
  reason?: CapacityResource;
  /** Epoch ms of the next 00:00 UTC, when the allowances reset. */
  resumesAt?: number;
  usage?: DailyUsage;
  checkedAt: number;
}

const CAPACITY_KEY = "capacity";
const CAPACITY_CACHE_MS = 30_000;
const OPEN: CapacityState = { paused: false, checkedAt: 0 };

let capacityCache: { state: CapacityState; loadedAt: number } | null = null;

export function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

/** Each isolate re-reads the flag every 30 s. A pause lapses by itself at midnight, before the next cron run. */
export async function capacityStatus(env: Pick<Env, "PARTITION_MAP">, now: number): Promise<CapacityState> {
  if (!capacityCache || now - capacityCache.loadedAt >= CAPACITY_CACHE_MS) {
    let stored: CapacityState | null = null;
    try {
      stored = await env.PARTITION_MAP.get<CapacityState>(CAPACITY_KEY, "json");
    } catch (error) {
      // Fail open: a KV hiccup should not take the app down.
      console.warn("Capacity flag unreadable", error);
    }
    capacityCache = { state: stored ?? OPEN, loadedAt: now };
  }
  const { state } = capacityCache;
  return state.paused && state.resumesAt !== undefined && now >= state.resumesAt ? OPEN : state;
}

/** Tests share one isolate; this drops the cached flag between them. */
export function forgetCapacity(): void {
  capacityCache = null;
}

export function evaluateUsage(usage: DailyUsage, now: number): CapacityState {
  const reason = (Object.keys(FREE_DAILY_LIMITS) as CapacityResource[])
    .find((resource) => usage[resource] >= FREE_DAILY_LIMITS[resource] * PAUSE_AT_FRACTION);
  return reason
    ? { paused: true, reason, resumesAt: nextUtcMidnight(now), usage, checkedAt: now }
    : { paused: false, usage, checkedAt: now };
}

/** Run by the cron. Without an analytics token it does nothing and the API stays open. */
export async function refreshCapacity(env: Env, now: number): Promise<void> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return;
  const usage = await fetchDailyUsage(env.CF_API_TOKEN, env.CF_ACCOUNT_ID, now);
  const next = evaluateUsage(usage, now);
  const current = await env.PARTITION_MAP.get<CapacityState>(CAPACITY_KEY, "json");
  // KV allows 1,000 writes a day on the free plan: write only when the verdict changes.
  if (current?.paused === next.paused && current?.reason === next.reason) return;
  await env.PARTITION_MAP.put(CAPACITY_KEY, JSON.stringify(next));
  console.log("Capacity changed", next);
}

const USAGE_QUERY = `query($account: String!, $start: Time!, $end: Time!, $date: Date!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workers: workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: $start, datetime_leq: $end }) { sum { requests } }
    durableObjects: durableObjectsInvocationsAdaptiveGroups(limit: 1, filter: { date: $date }) { sum { requests } }
    queues: queueMessageOperationsAdaptiveGroups(limit: 1, filter: { datetime_geq: $start, datetime_leq: $end }) { sum { billableOperations } }
  } }
}`;

interface UsageResult {
  data?: { viewer?: { accounts?: Array<{
    workers?: Array<{ sum?: { requests?: number } }>;
    durableObjects?: Array<{ sum?: { requests?: number } }>;
    queues?: Array<{ sum?: { billableOperations?: number } }>;
  }> } };
  errors?: Array<{ message: string }> | null;
}

/** Account-wide usage since 00:00 UTC; the free allowances are per account, not per Worker. */
export async function fetchDailyUsage(token: string, account: string, now: number): Promise<DailyUsage> {
  const end = new Date(now).toISOString();
  const date = end.slice(0, 10);
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: USAGE_QUERY, variables: { account, start: `${date}T00:00:00Z`, end, date } }),
  });
  const result = await response.json() as UsageResult;
  const usage = result.data?.viewer?.accounts?.[0];
  if (!response.ok || result.errors?.length || !usage) {
    throw new Error(`Usage query failed (${response.status}): ${result.errors?.[0]?.message ?? "no data"}`);
  }
  return {
    workers: usage.workers?.[0]?.sum?.requests ?? 0,
    durableObjects: usage.durableObjects?.[0]?.sum?.requests ?? 0,
    queues: usage.queues?.[0]?.sum?.billableOperations ?? 0,
  };
}
