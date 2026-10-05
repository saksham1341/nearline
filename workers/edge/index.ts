import { handleAction } from "./api/actions.ts";
import type { ApiContext } from "./api/context.ts";
import { handleEngagement } from "./api/engagement.ts";
import { handleFeed } from "./api/feed.ts";
import { handleThread } from "./api/threads.ts";
import { handleAuth } from "./auth/routes.ts";
import { authenticate } from "./auth/session.ts";
import { CellIndex } from "./durable-objects/cell-index.ts";
import { ThreadStore } from "./durable-objects/thread-store.ts";
import { UserState } from "./durable-objects/user-state.ts";
import type { Env } from "./env.ts";
import type { FeedEvent } from "./events.ts";
import { errorResponse, finalizeApiResponse, HttpError, json, readJson } from "./http.ts";
import { consumeEvents } from "./queue/consumer.ts";
import { createServices } from "./services-env.ts";

export { CellIndex, ThreadStore, UserState };

const THREAD_PATH = /^\/api\/threads\/([0-9a-f-]{36})$/u;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/auth/")) return await handleAuth(request, env, url.pathname);
      if (url.pathname === "/api/client-error" && request.method === "POST") return await logClientError(request);
      if (url.pathname === "/api/health") return json({ ok: true });
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (error) {
      return errorResponse(error);
    }
  },

  async queue(batch: MessageBatch<FeedEvent>, env: Env): Promise<void> {
    // Retry only the messages whose target failed; the rest are acknowledged. After max_retries the
    // queue moves a message to the dead-letter queue instead of dropping it.
    try {
      const failed = new Set((await consumeEvents(batch.messages.map((message) => message.body), createServices(env), Date.now()))
        .map((event) => event.eventId));
      for (const message of batch.messages) {
        if (failed.has(message.body.eventId)) message.retry();
        else message.ack();
      }
    } catch (error) {
      console.error("Feed event batch failed; retrying", error);
      batch.retryAll();
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
      env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
    ]);
  },
} satisfies ExportedHandler<Env, FeedEvent>;

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  // SameSite cookies stop cross-site pages, not sibling subdomains.
  if (request.method === "POST" && request.headers.get("origin") !== env.ORIGIN) {
    throw new HttpError(403, "FORBIDDEN_ORIGIN");
  }
  const auth = await authenticate(request, env);
  if (!auth) throw new HttpError(401, "UNAUTHORIZED");
  const ctx: ApiContext = { services: createServices(env), user: auth.user, now: Date.now() };
  return finalizeApiResponse(await route(request, url, ctx), auth.setCookies, Date.now());
}

async function route(request: Request, url: URL, ctx: ApiContext): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/feed") return handleFeed(url, request, ctx);
  if (request.method === "GET" && url.pathname === "/api/me/engagement") return handleEngagement(url, ctx);
  if (request.method === "POST" && url.pathname === "/api/actions") return handleAction(request, ctx);
  const thread = THREAD_PATH.exec(url.pathname);
  if (request.method === "GET" && thread) return handleThread(thread[1]!, url, request, ctx);
  throw new HttpError(404, "NOT_FOUND");
}

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
