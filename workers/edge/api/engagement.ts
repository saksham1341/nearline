import { isUuid } from "../../../packages/protocol/index.ts";
import { MAX_ENGAGEMENT_IDS } from "../../../packages/shared/constants.ts";
import { json } from "../http.ts";
import type { ApiContext } from "./context.ts";
import { errorJson } from "./respond.ts";

/** Per-viewer flags. Never cached: it is private to the signed-in user. */
export async function handleEngagement(url: URL, ctx: ApiContext): Promise<Response> {
  const ids = (url.searchParams.get("threads") ?? "").split(",").filter(Boolean);
  if (ids.length > MAX_ENGAGEMENT_IDS || !ids.every(isUuid)) return errorJson(400, "BAD_REQUEST");
  if (!await ctx.services.limit("read", ctx.user.id)) return errorJson(429, "RATE_LIMITED");
  const state = await ctx.services.user(ctx.user.id);
  return json(await state.engagement(ctx.user.id, ids));
}
