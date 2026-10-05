import type {
  ActionRequest,
  ActionResponse,
  EngagementResponse,
  FeedResponse,
  FeedTab,
  ThreadResponse,
} from "../../packages/protocol/index.ts";
import type { ProximityScope } from "../../packages/shared/constants.ts";

export type Fetched<T> =
  | { status: "fresh"; data: T; etag: string | null }
  | { status: "unchanged" }
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

async function getJson<T>(url: string, etag: string | null): Promise<Fetched<T>> {
  let response: Response;
  try {
    response = await fetch(url, { headers: etag ? { "if-none-match": etag } : {}, credentials: "same-origin" });
  } catch {
    return { status: "error" };
  }
  if (response.status === 304) return { status: "unchanged" };
  if (response.status === 401) return { status: "unauthorized" };
  if (response.status === 404 || response.status === 410) return { status: "gone" };
  if (!response.ok) return { status: "error" };
  return { status: "fresh", data: await response.json() as T, etag: response.headers.get("etag") };
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
    return await response.json() as ActionResponse;
  } catch {
    return { id: action.id, ok: false, code: "UNAVAILABLE" };
  }
}
