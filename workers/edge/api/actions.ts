import { locationHintFor } from "../../../packages/feed/location-hint.ts";
import { partitionFor, regionPartitions } from "../../../packages/feed/partition.ts";
import { regionCells } from "../../../packages/geo/index.ts";
import {
  isValidPostBody,
  parseActionRequest,
  type ActionOutcome,
  type ActionResponse,
} from "../../../packages/protocol/index.ts";
import type { ProximityScope } from "../../../packages/shared/constants.ts";
import { uuidv7 } from "../../../packages/shared/uuid.ts";
import { json } from "../http.ts";
import type { ApiContext } from "./context.ts";
import { statusFor } from "./respond.ts";

export async function handleAction(request: Request, ctx: ApiContext): Promise<Response> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    input = null;
  }
  const action = parseActionRequest(input);
  if (!action) {
    const id = typeof (input as { id?: unknown } | null)?.id === "string" ? (input as { id: string }).id : "";
    return json({ id, ok: false, code: "BAD_REQUEST" } satisfies ActionResponse, { status: 400 });
  }
  const respond = (outcome: ActionOutcome): Response =>
    json({ id: action.id, ...outcome } satisfies ActionResponse, { status: outcome.ok ? 200 : statusFor(outcome.code) });

  if ((action.type === "post" || action.type === "reply") && !isValidPostBody(action.body)) {
    return respond({ ok: false, code: "INVALID_MESSAGE" });
  }
  if (!await ctx.services.limit(action.type === "like" ? "like" : "message", ctx.user.id)) {
    return respond({ ok: false, code: "RATE_LIMITED" });
  }
  if (action.type === "reply" || action.type === "like" || action.type === "repost") {
    if (!await isVisible(action.threadId, action.cell, action.scope, action.room, ctx)) {
      return respond({ ok: false, code: "NOT_VISIBLE" });
    }
  }

  const actor = { userId: ctx.user.id, author: ctx.user.author };
  const now = ctx.now;
  switch (action.type) {
    case "post": {
      const id = uuidv7(now);
      const partition = partitionFor(action.location, await ctx.services.partitionMap(now), now).write;
      const outcome = await ctx.services.thread(id, locationHintFor(action.location)).create({
        id, actor, roomTag: action.room, location: action.location, partition, body: action.body, now,
      });
      return respond(outcome.ok ? { ok: true, postId: id } : outcome);
    }
    case "reply": {
      const postId = uuidv7(now);
      const outcome = await ctx.services.thread(action.threadId).reply({ postId, parentId: action.parentId, actor, body: action.body, now });
      return respond(outcome.ok ? { ok: true, postId } : outcome);
    }
    case "delete": {
      const outcome = await ctx.services.thread(action.threadId).remove({ postId: action.postId, actor, now });
      return respond(outcome.ok ? { ok: true } : outcome);
    }
    case "like": {
      const state = await ctx.services.user(ctx.user.id);
      const result = await state.like({ userId: ctx.user.id, postId: action.postId, threadId: action.threadId, on: action.on, now });
      if (result.changed) {
        await ctx.services.sendEvents([{
          eventId: uuidv7(now), type: "thread.liked", threadId: result.threadId, postId: action.postId,
          userId: ctx.user.id, delta: action.on ? 1 : -1, first: result.first, at: now,
        }]);
      }
      return respond({ ok: true });
    }
    case "repost": {
      const state = await ctx.services.user(ctx.user.id);
      const result = await state.repost({ userId: ctx.user.id, threadId: action.threadId, now });
      if (!result.ok) return respond({ ok: false, code: "ALREADY_REPOSTED" });
      const partition = partitionFor(action.location, await ctx.services.partitionMap(now), now).write;
      await ctx.services.sendEvents([{
        eventId: uuidv7(now), type: "thread.reposted", threadId: action.threadId, userId: ctx.user.id,
        first: result.first, location: action.location, partition, byAuthor: actor.author, at: now,
      }]);
      return respond({ ok: true });
    }
  }
}

/** A viewer may act on a thread only if one of its anchors is inside their region. */
async function isVisible(threadId: string, cell: string, scope: ProximityScope, room: string, ctx: ApiContext): Promise<boolean> {
  const cells = regionCells(cell);
  const partitions = regionPartitions(cells, await ctx.services.partitionMap(ctx.now), ctx.now);
  const answers = await Promise.all(partitions.map((partition) =>
    ctx.services.cell(partition).hasRef(partition, { threadId, cells, scope, room, now: ctx.now })));
  return answers.some(Boolean);
}
