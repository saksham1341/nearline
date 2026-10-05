import { isCanonicalLocation, locationToShard } from "../../packages/geo/index.ts";
import { isRoomTag } from "../../packages/protocol/index.ts";
import { isProximityScope, PROXIMITY_SCOPES } from "../../packages/shared/constants.ts";
import { handleAuth } from "./auth/routes.ts";
import { authenticate } from "./auth/session.ts";
import { GeoShardLive } from "./durable-objects/geo-shard.ts";
import type { Env } from "./env.ts";
import { errorResponse, HttpError, json, readJson } from "./http.ts";

export { GeoShardLive };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/auth/")) return await handleAuth(request, env, url.pathname);
      if (url.pathname === "/api/client-error" && request.method === "POST") return await logClientError(request);
      if (url.pathname === "/api/socket") return await openSocket(request, env, url);
      if (url.pathname === "/api/health") return json({ ok: true });
      return env.ASSETS.fetch(request);
    } catch (error) {
      return errorResponse(error);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
      env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
    ]);
  },
} satisfies ExportedHandler<Env>;

async function logClientError(request: Request): Promise<Response> {
  const input = await readJson<{ area?: unknown; operation?: unknown; name?: unknown; message?: unknown }>(request);
  const area = boundedDiagnostic(input.area, 32);
  const operation = boundedDiagnostic(input.operation, 32);
  const name = boundedDiagnostic(input.name, 80);
  const message = boundedDiagnostic(input.message, 300);
  console.warn("Client error", { area, operation, name, message });
  return new Response(null, { status: 204 });
}

function boundedDiagnostic(value: unknown, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit) : "unknown";
}

async function openSocket(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(426, "WEBSOCKET_REQUIRED");
  }
  // SameSite cookies stop cross-site pages, not sibling subdomains; browsers always send Origin on WebSocket upgrades.
  if (request.headers.get("origin") !== env.ORIGIN) throw new HttpError(403, "FORBIDDEN_ORIGIN");
  const user = await authenticate(request, env);
  if (!user) throw new HttpError(401, "UNAUTHORIZED");
  const location = url.searchParams.get("location");
  if (!isCanonicalLocation(location)) throw new HttpError(400, "INVALID_LOCATION");
  // Scope and room arrive with the upgrade so the connection never starts on the public, default-range filter.
  const scope = Number(url.searchParams.get("scope") ?? PROXIMITY_SCOPES.nearby);
  if (!isProximityScope(scope)) throw new HttpError(400, "INVALID_SCOPE");
  const roomTag = url.searchParams.get("room") ?? "";
  if (!isRoomTag(roomTag)) throw new HttpError(400, "INVALID_ROOM_TAG");
  const { success } = await env.CONNECT_LIMITER.limit({ key: user.id });
  if (!success) throw new HttpError(429, "RATE_LIMITED");

  const headers = new Headers(request.headers);
  headers.set("x-user-id", user.id);
  headers.set("x-author", user.authorHash);
  headers.set("x-location", location);
  headers.set("x-scope", String(scope));
  headers.set("x-room", roomTag);
  const forwarded = new Request("https://geo.internal/connect", { method: "GET", headers });
  return env.GEO_SHARD.getByName(locationToShard(location)).fetch(forwarded);
}
