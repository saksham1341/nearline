import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFeed, sendAction } from "../apps/web/api.ts";

const action = { id: "11111111-1111-4111-8111-111111111111", type: "delete" as const, threadId: "t", postId: "p" };

function respond(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));
}

describe("sending actions", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("passes action results through", async () => {
    respond(409, { id: action.id, ok: false, code: "ALREADY_REPOSTED" });
    expect(await sendAction(action)).toEqual({ id: action.id, ok: false, code: "ALREADY_REPOSTED" });
  });

  it("turns plain server errors into action results with a code", async () => {
    respond(403, { error: "FORBIDDEN_ORIGIN" });
    expect(await sendAction(action)).toEqual({ id: action.id, ok: false, code: "FORBIDDEN_ORIGIN" });
    respond(500, { error: "INTERNAL_ERROR" });
    expect(await sendAction(action)).toEqual({ id: action.id, ok: false, code: "UNAVAILABLE" });
    respond(502, "<html>bad gateway</html>");
    expect(await sendAction(action)).toEqual({ id: action.id, ok: false, code: "UNAVAILABLE" });
  });

  it("reads the server's clock from the response header, even on 304", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 304, headers: { "x-server-time": "5000" } })));
    const result = await fetchFeed({ cell: "c", scope: 10, room: "", tab: "latest", cursor: null }, "\"v\"");
    expect(result).toEqual({ status: "unchanged", serverTime: 5_000 });
  });
});
