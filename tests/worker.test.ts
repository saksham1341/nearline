import { describe, expect, it, vi } from "vitest";
import { signAccessToken } from "../packages/shared/session-token.ts";
import { uuidv7 } from "../packages/shared/uuid.ts";
import { forgetCapacity } from "../workers/edge/capacity.ts";
import worker from "../workers/edge/index.ts";
import type { FeedEvent } from "../workers/edge/events.ts";
import { fakeQueue } from "./support/fake-cloudflare.ts";

const ORIGIN = "https://nearline.test";
const SESSION_KEY = "test-key-that-is-at-least-32-chars-long";

function fakeEnv(threadStub: (id: string) => object = () => ({}), capacity: object | null = null) {
  const allow = { limit: async () => ({ success: true }) };
  return {
    ORIGIN,
    SESSION_KEY,
    RP_ID: "nearline.test",
    RP_NAME: "Nearline",
    ASSETS: { fetch: async () => new Response("asset") },
    DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => (sql.includes("FROM sessions") ? { id: "user-1", author_hash: "abcd1234ffffffff" } : null),
          run: async () => ({}),
        }),
      }),
    },
    THREAD_STORE: { getByName: (id: string) => threadStub(id) },
    CELL_INDEX: { getByName: () => ({}) },
    USER_STATE: { getByName: () => ({}) },
    FEED_EVENTS: fakeQueue(),
    PARTITION_MAP: { list: async () => ({ keys: [], list_complete: true }), get: async () => capacity },
    MESSAGE_LIMITER: allow,
    LIKE_LIMITER: allow,
    READ_LIMITER: allow,
    REGISTER_LIMITER: allow,
  };
}

async function accessCookie(exp = Date.now() + 60_000): Promise<string> {
  return `pc_access=${await signAccessToken({ uid: "user-1", author: "abcd1234", sid: "s", exp }, SESSION_KEY)}`;
}

const call = (request: Request, env = fakeEnv()) => worker.fetch(request, env as never);

describe("Worker routing", () => {
  it("requires sign-in on every API route", async () => {
    for (const path of ["/api/feed?tab=latest", "/api/threads/00000000-0000-7000-8000-000000000001", "/api/me/engagement"]) {
      const response = await call(new Request(`${ORIGIN}${path}`));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "UNAUTHORIZED" });
    }
  });

  it("rejects POSTs from any other origin, or with none, even when signed in", async () => {
    const cookie = await accessCookie();
    for (const headers of [{ cookie, origin: "https://evil.example" }, { cookie }]) {
      const response = await call(new Request(`${ORIGIN}/api/actions`, { method: "POST", headers, body: "{}" }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "FORBIDDEN_ORIGIN" });
    }
  });

  it("serves signed-in API calls privately, stamped with the server time", async () => {
    const response = await call(new Request(`${ORIGIN}/api/feed?cell=x&scope=10&room=&tab=latest`, { headers: { cookie: await accessCookie() } }));
    expect(response.status).toBe(400);
    expect(Number(response.headers.get("x-server-time"))).toBeGreaterThan(0);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const missing = await call(new Request(`${ORIGIN}/api/nothing-here`, { headers: { cookie: await accessCookie() } }));
    expect(missing.status).toBe(404);
  });

  it("refreshes an expired access token from the session, never cacheably", async () => {
    const headers = { cookie: `${await accessCookie(1)}; pc_session=refresh-token` };
    const response = await call(new Request(`${ORIGIN}/api/feed?cell=x&scope=10&room=&tab=latest`, { headers }));
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toMatch(/^pc_access=/u);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("serves everything outside /api from static assets", async () => {
    expect(await (await call(new Request(`${ORIGIN}/how-it-works`))).text()).toBe("asset");
  });
});

describe("Worker capacity pause", () => {
  it("reports open status and serves the API while under the daily allowance", async () => {
    forgetCapacity();
    const response = await call(new Request(`${ORIGIN}/api/status`));
    expect(await response.json()).toEqual({ paused: false, reason: null, resumesAt: null });
    expect((await call(new Request(`${ORIGIN}/api/feed?tab=latest`))).status).toBe(401);
  });

  it("refuses every API call except status once paused, without checking the session", async () => {
    forgetCapacity();
    const resumesAt = Date.now() + 3_600_000;
    const env = fakeEnv(undefined, { paused: true, reason: "durableObjects", resumesAt, checkedAt: Date.now() });
    const status = await call(new Request(`${ORIGIN}/api/status`), env);
    expect(await status.json()).toEqual({ paused: true, reason: "durableObjects", resumesAt });
    for (const path of ["/api/feed?tab=latest", "/api/auth/session"]) {
      const response = await call(new Request(`${ORIGIN}${path}`), env);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "OVER_CAPACITY", resumesAt });
    }
    expect(await (await call(new Request(`${ORIGIN}/`), env)).text()).toBe("asset");
    forgetCapacity();
  });

  it("lifts a pause by itself once the allowances reset", async () => {
    forgetCapacity();
    const env = fakeEnv(undefined, { paused: true, reason: "workers", resumesAt: Date.now() - 1, checkedAt: 0 });
    expect(await (await call(new Request(`${ORIGIN}/api/status`), env)).json()).toMatchObject({ paused: false });
    forgetCapacity();
  });
});

describe("Worker queue handler", () => {
  it("acknowledges applied messages and retries only those whose target failed", async () => {
    const healthy = uuidv7();
    const broken = uuidv7();
    const applied: string[] = [];
    const env = fakeEnv((id) => ({
      applyLikes: async () => {
        if (id === broken) throw new Error("store down");
        applied.push(id);
      },
    }));
    const message = (threadId: string, eventId: string) => ({
      body: { eventId, type: "thread.liked", threadId, postId: threadId, userId: "u", delta: 1, first: true, at: 1 } as FeedEvent,
      ack: vi.fn(),
      retry: vi.fn(),
    });
    const ok = message(healthy, "e1");
    const bad = message(broken, "e2");
    await worker.queue({ messages: [ok, bad], retryAll: vi.fn(), ackAll: vi.fn() } as never, env as never);
    expect(applied).toEqual([healthy]);
    expect(ok.ack).toHaveBeenCalled();
    expect(ok.retry).not.toHaveBeenCalled();
    expect(bad.retry).toHaveBeenCalled();
    expect(bad.ack).not.toHaveBeenCalled();
  });
});
