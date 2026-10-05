import { mergePage } from "../../../packages/feed/order.ts";
import { regionPartitions } from "../../../packages/feed/partition.ts";
import { isScopeCell, regionCells } from "../../../packages/geo/index.ts";
import { isRoomTag, type FeedItem, type FeedResponse, type FeedTab, type ThreadSummary } from "../../../packages/protocol/index.ts";
import {
  FEED_CACHE_SECONDS,
  isProximityScope,
  PARTITION_QUERY_LIMIT,
  THREAD_CACHE_SECONDS,
  type ProximityScope,
} from "../../../packages/shared/constants.ts";
import { json } from "../http.ts";
import type { ApiContext } from "./context.ts";
import { CACHE_ORIGIN, conditional, errorJson, sharedCacheControl, versionHash } from "./respond.ts";

interface FeedParams {
  cell: string;
  scope: ProximityScope;
  room: string;
  tab: FeedTab;
  cursor: string | null;
}

export async function handleFeed(url: URL, request: Request, ctx: ApiContext): Promise<Response> {
  const scope = Number(url.searchParams.get("scope"));
  const cell = url.searchParams.get("cell");
  const room = url.searchParams.get("room") ?? "";
  const tab = url.searchParams.get("tab");
  const cursor = url.searchParams.get("cursor") || null;
  if (!isProximityScope(scope)) return errorJson(400, "INVALID_SCOPE");
  if (!isScopeCell(cell, scope)) return errorJson(400, "INVALID_LOCATION");
  if (!isRoomTag(room)) return errorJson(400, "INVALID_ROOM_TAG");
  if (tab !== "latest" && tab !== "trending") return errorJson(400, "BAD_REQUEST");
  if (cursor !== null && cursor.length > 120) return errorJson(400, "BAD_REQUEST");
  if (!await ctx.services.limit("read", ctx.user.id)) return errorJson(429, "RATE_LIMITED");

  const params: FeedParams = { cell, scope, room, tab, cursor };
  // Everyone in the same scope cell, room and tab sees the same feed, so one cached copy serves them all.
  const key = `${CACHE_ORIGIN}/feed?${new URLSearchParams({ cell, scope: String(scope), room, tab, cursor: cursor ?? "" })}`;
  const cached = await ctx.services.cache.match(key);
  if (cached) return conditional(request, cached);
  const response = await buildFeed(params, ctx);
  await ctx.services.cache.put(key, response.clone());
  return conditional(request, response);
}

async function buildFeed(params: FeedParams, ctx: ApiContext): Promise<Response> {
  const region = regionCells(params.cell);
  const map = await ctx.services.partitionMap(ctx.now);
  const partitions = regionPartitions(region, map, ctx.now);
  const pages = await Promise.all(partitions.map((partition) => ctx.services.cell(partition).query(partition, {
    cells: region,
    scope: params.scope,
    room: params.room,
    tab: params.tab,
    cursor: params.cursor,
    limit: PARTITION_QUERY_LIMIT,
    now: ctx.now,
  })));
  const page = mergePage(pages.map((result) => result.refs), params.tab);
  const summaries = await Promise.all(page.refs.map((ref) => summaryFor(ref.threadId, ctx)));
  const items: FeedItem[] = [];
  page.refs.forEach((ref, index) => {
    const summary = summaries[index];
    if (!summary || summary.roomTag !== params.room || summary.expiresAt <= ctx.now) return;
    items.push({ summary, via: { cell11: ref.cell11, kind: ref.kind, byAuthor: ref.byAuthor, createdAt: ref.anchorAt } });
  });
  const version = await versionHash([
    ...partitions.map((partition, index) => `${partition}:${pages[index]!.version}`),
    ...items.map((item) => `${item.summary.id}:${item.summary.version}:${item.via.createdAt}`),
  ]);
  const body: FeedResponse = { version, serverTime: ctx.now, items, nextCursor: page.nextCursor };
  return json(body, { headers: { etag: `"${version}"`, "cache-control": sharedCacheControl(FEED_CACHE_SECONDS) } });
}

/** Summaries come from the thread's own store, through a 2-second shared cache. */
async function summaryFor(threadId: string, ctx: ApiContext): Promise<ThreadSummary | null> {
  const key = `${CACHE_ORIGIN}/summary/${threadId}`;
  const hit = await ctx.services.cache.match(key);
  if (hit) return (await hit.json() as { summary: ThreadSummary }).summary;
  const outcome = await ctx.services.thread(threadId).summary(ctx.now);
  if (!outcome.ok) return null;
  await ctx.services.cache.put(
    key,
    json({ summary: outcome.summary }, { headers: { "cache-control": sharedCacheControl(THREAD_CACHE_SECONDS) } }),
  );
  return outcome.summary;
}
