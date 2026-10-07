import {
  isErrorCode,
  type ActionRequest,
  type ActionResponse,
  type EngagementResponse,
  type FeedResponse,
  type FeedTab,
  type ThreadResponse,
} from "../../packages/protocol/index.ts";
import type { ProximityScope } from "../../packages/shared/constants.ts";

export type Fetched<T> =
  | { status: "fresh"; data: T; etag: string | null; serverTime: number | null }
  | { status: "unchanged"; serverTime: number | null }
  | { status: "gone" }
  | { status: "unauthorized" }
  | { status: "error" };

export interface FeedParams {
  cell: string;
  scope: ProximityScope;
  room: string;
  tab: FeedTab;
  cursor: string | null;
}

export interface CapacityStatus {
  paused: boolean;
  /** Epoch ms when the service comes back, if known. */
  resumesAt: number | null;
}

let pausedListener: ((resumesAt: number | null) => void) | null = null;

/** Called whenever any API response says the service is paused for the day. */
export function onPaused(listener: (resumesAt: number | null) => void): void {
  pausedListener = listener;
}

/**
 * Our own pause is a 503 OVER_CAPACITY. Once the Workers allowance is fully spent the Worker never runs and
 * Cloudflare answers with its own non-JSON 429 page instead, which means the same thing.
 */
export async function detectPause(response: Response): Promise<boolean> {
  const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
  if (response.status === 429 && !isJson) {
    pausedListener?.(null);
    return true;
  }
  if (response.status !== 503 || !isJson) return false;
  const body = await response.clone().json().catch(() => null) as { error?: unknown; resumesAt?: unknown } | null;
  if (body?.error !== "OVER_CAPACITY") return false;
  pausedListener?.(typeof body.resumesAt === "number" ? body.resumesAt : null);
  return true;
}

/** Null when the service can't be reached at all, which is not the same as paused. */
export async function fetchStatus(): Promise<CapacityStatus | null> {
  try {
    const response = await fetch("/api/status", { credentials: "same-origin" });
    if (response.status === 429 && !(response.headers.get("content-type") ?? "").includes("application/json")) {
      return { paused: true, resumesAt: null };
    }
    if (!response.ok) return null;
    const body = await response.json() as { paused?: unknown; resumesAt?: unknown };
    return { paused: body.paused === true, resumesAt: typeof body.resumesAt === "number" ? body.resumesAt : null };
  } catch {
    return null;
  }
}

async function getJson<T>(url: string, etag: string | null): Promise<Fetched<T>> {
  let response: Response;
  try {
    response = await fetch(url, { headers: etag ? { "if-none-match": etag } : {}, credentials: "same-origin" });
  } catch {
    return { status: "error" };
  }
  const header = Number(response.headers.get("x-server-time"));
  const serverTime = Number.isFinite(header) && header > 0 ? header : null;
  if (response.status === 304) return { status: "unchanged", serverTime };
  if (response.status === 401) return { status: "unauthorized" };
  if (response.status === 404 || response.status === 410) return { status: "gone" };
  if (await detectPause(response)) return { status: "error" };
  if (!response.ok) return { status: "error" };
  return { status: "fresh", data: await response.json() as T, etag: response.headers.get("etag"), serverTime };
}

export function fetchFeed(params: FeedParams, etag: string | null): Promise<Fetched<FeedResponse>> {
  const query = new URLSearchParams({ cell: params.cell, scope: String(params.scope), room: params.room, tab: params.tab });
  if (params.cursor) query.set("cursor", params.cursor);
  return getJson<FeedResponse>(`/api/feed?${query}`, etag);
}

export function fetchThread(threadId: string, room: string, etag: string | null): Promise<Fetched<ThreadResponse>> {
  return getJson<ThreadResponse>(`/api/threads/${threadId}?${new URLSearchParams({ room })}`, etag);
}

export async function fetchEngagement(threadIds: readonly string[]): Promise<EngagementResponse | null> {
  if (threadIds.length === 0) return null;
  const result = await getJson<EngagementResponse>(`/api/me/engagement?${new URLSearchParams({ threads: threadIds.join(",") })}`, null);
  return result.status === "fresh" ? result.data : null;
}

export async function sendAction(action: ActionRequest): Promise<ActionResponse> {
  try {
    const response = await fetch("/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
      credentials: "same-origin",
    });
    if (response.status === 401) return { id: action.id, ok: false, code: "UNAUTHORIZED" };
    if (await detectPause(response)) return { id: action.id, ok: false, code: "UNAVAILABLE" };
    const body = await response.json().catch(() => null) as Partial<ActionResponse> & { error?: unknown } | null;
    if (body && typeof body.ok === "boolean") return body as ActionResponse;
    // Errors raised before the action handler (origin check, server faults) carry { error } only.
    return { id: action.id, ok: false, code: isErrorCode(body?.error) ? body.error : "UNAVAILABLE" };
  } catch {
    return { id: action.id, ok: false, code: "UNAVAILABLE" };
  }
}
