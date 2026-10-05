import { describe, expect, it } from "vitest";
import { finalizeApiResponse, json } from "../workers/edge/http.ts";

describe("responses sent to browsers", () => {
  const sharedFeed = () =>
    json({ items: [] }, { headers: { etag: "\"v1\"", "cache-control": "public, max-age=0, s-maxage=3" } });

  it("never lets a shared cache store a response that carries a session cookie", () => {
    const response = finalizeApiResponse(sharedFeed(), ["pc_access=secret; Path=/; HttpOnly; Secure"], 0);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("set-cookie")).toContain("pc_access=secret");
    expect(response.headers.get("etag")).toBe("\"v1\"");
  });

  it("keeps edge-shared responses private on the way to the browser", () => {
    const response = finalizeApiResponse(sharedFeed(), [], 0);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("etag")).toBe("\"v1\"");
  });

  it("leaves no-store responses alone", () => {
    const response = finalizeApiResponse(json({ ok: true }), [], 0);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("works on responses with immutable headers, such as Cache API hits", () => {
    const cached = new Response("{}", { headers: { "cache-control": "public, s-maxage=3" } });
    Object.freeze(cached.headers);
    expect(() => finalizeApiResponse(cached, ["a=b"], 0)).not.toThrow();
  });
});

describe("server time", () => {
  it("stamps the current time on every response, cached or not", () => {
    const cached = new Response(null, { status: 304, headers: { etag: "\"v1\"" } });
    expect(finalizeApiResponse(cached, [], 1_234).headers.get("x-server-time")).toBe("1234");
  });
});

describe("conditional requests", () => {
  it("matches ETags weakly, as If-None-Match requires, including lists and W/ prefixes", async () => {
    const { conditional } = await import("../workers/edge/api/respond.ts");
    const fresh = () => new Response("{}", { headers: { etag: "\"abc\"", "cache-control": "public, s-maxage=3" } });
    const ask = (value: string) => conditional(new Request("https://x/", { headers: { "if-none-match": value } }), fresh()).status;
    expect(ask("\"abc\"")).toBe(304);
    expect(ask("W/\"abc\"")).toBe(304);
    expect(ask("\"zzz\", W/\"abc\"")).toBe(304);
    expect(ask("*")).toBe(304);
    expect(ask("\"zzz\"")).toBe(200);
    const weakStored = new Response("{}", { headers: { etag: "W/\"abc\"" } });
    expect(conditional(new Request("https://x/", { headers: { "if-none-match": "\"abc\"" } }), weakStored).status).toBe(304);
  });
});
