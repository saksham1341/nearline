import { describe, expect, it } from "vitest";
import { ACCESS_TOKEN_TTL_MS } from "../packages/shared/constants.ts";
import { authenticate, createSession, destroySession } from "../workers/edge/auth/session.ts";

interface FakeRow { id: string; author_hash: string }

function fakeEnv(session: FakeRow | null = null) {
  const calls: string[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind: () => ({
          first: async () => { calls.push(sql); return sql.includes("FROM sessions") ? session : null; },
          run: async () => { calls.push(sql); return {}; },
        }),
      };
    },
  };
  return { env: { DB: DB as never, SESSION_KEY: "test-key-that-is-at-least-32-chars-long" }, calls };
}

const valueOf = (setCookie: string) => setCookie.split(";")[0]!.split("=").slice(1).join("=");
const nameOf = (setCookie: string) => setCookie.split("=")[0];
const request = (cookie: string) => new Request("https://nearline.test/", { headers: { cookie } });

describe("sessions", () => {
  it("issues a refresh cookie and an access cookie at sign-in", async () => {
    const { env, calls } = fakeEnv();
    const cookies = await createSession(env, "user-1", "abcd1234", 1_000);
    expect(cookies.map(nameOf)).toEqual(["pc_session", "pc_access"]);
    expect(calls).toHaveLength(1);
  });

  it("authenticates from the access token without touching the database", async () => {
    const { env, calls } = fakeEnv();
    const [, access] = await createSession(env, "user-1", "abcd1234", 1_000);
    calls.length = 0;
    const result = await authenticate(request(`pc_access=${valueOf(access!)}`), env, 2_000);
    expect(result).toEqual({ user: { id: "user-1", author: "abcd1234" }, setCookies: [] });
    expect(calls).toEqual([]);
  });

  it("falls back to the refresh session and re-issues an access token", async () => {
    const { env, calls } = fakeEnv({ id: "user-1", author_hash: "abcd1234ffffffff" });
    const [refresh, access] = await createSession(env, "user-1", "abcd1234", 1_000);
    calls.length = 0;
    const expired = 1_000 + ACCESS_TOKEN_TTL_MS;
    const result = await authenticate(request(`pc_access=${valueOf(access!)}; pc_session=${valueOf(refresh!)}`), env, expired);
    expect(result?.user).toEqual({ id: "user-1", author: "abcd1234" });
    expect(result?.setCookies.map(nameOf)).toEqual(["pc_access"]);
    expect(calls).toHaveLength(1);
  });

  it("rejects missing, tampered and unknown sessions", async () => {
    const { env } = fakeEnv(null);
    expect(await authenticate(request(""), env, 1)).toBeNull();
    expect(await authenticate(request("pc_access=forged.token"), env, 1)).toBeNull();
    expect(await authenticate(request("pc_session=unknown"), env, 1)).toBeNull();
  });

  it("clears both cookies at sign-out", async () => {
    const { env } = fakeEnv();
    const cookies = await destroySession(request("pc_session=abc"), env);
    expect(cookies.map(nameOf)).toEqual(["pc_session", "pc_access"]);
    expect(cookies.every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
  });

  it("refuses to run without a strong SESSION_KEY", async () => {
    for (const key of ["", "short"]) {
      const env = { DB: fakeEnv().env.DB, SESSION_KEY: key };
      await expect(createSession(env, "user-1", "abcd1234", 1)).rejects.toThrow(/SESSION_KEY/u);
      await expect(authenticate(request("pc_access=anything"), env, 1)).rejects.toThrow(/SESSION_KEY/u);
    }
  });
});
