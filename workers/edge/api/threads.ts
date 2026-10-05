import { isRoomTag, isUuid, type ThreadResponse } from "../../../packages/protocol/index.ts";
import { THREAD_CACHE_SECONDS } from "../../../packages/shared/constants.ts";
import { json } from "../http.ts";
import type { ApiContext } from "./context.ts";
import { CACHE_ORIGIN, conditional, errorJson, sharedCacheControl, statusFor } from "./respond.ts";

/** Reading a thread needs only its id (74 random bits, unguessable) and the matching room. */
export async function handleThread(threadId: string, url: URL, request: Request, ctx: ApiContext): Promise<Response> {
  const room = url.searchParams.get("room") ?? "";
  if (!isUuid(threadId)) return errorJson(400, "BAD_REQUEST");
  if (!isRoomTag(room)) return errorJson(400, "INVALID_ROOM_TAG");
  if (!await ctx.services.limit("read", ctx.user.id)) return errorJson(429, "RATE_LIMITED");

  const key = `${CACHE_ORIGIN}/thread/${threadId}?room=${room}`;
  const cached = await ctx.services.cache.match(key);
  if (cached) return conditional(request, cached);

  const outcome = await ctx.services.thread(threadId).thread(ctx.now);
  if (!outcome.ok) return errorJson(statusFor(outcome.code), outcome.code);
  // A wrong room answers exactly like a missing thread, so rooms cannot be probed.
  if (outcome.summary.roomTag !== room) return errorJson(404, "THREAD_NOT_FOUND");
  const body: ThreadResponse = { version: outcome.summary.version, serverTime: ctx.now, summary: outcome.summary, posts: outcome.posts };
  const response = json(body, {
    headers: { etag: `"t${outcome.summary.version}"`, "cache-control": sharedCacheControl(THREAD_CACHE_SECONDS) },
  });
  await ctx.services.cache.put(key, response.clone());
  return conditional(request, response);
}
