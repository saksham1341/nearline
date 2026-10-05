import { describe, expect, it } from "vitest";
import { finalizeApiResponse, json } from "../workers/edge/http.ts";

describe("responses sent to browsers", () => {
  const sharedFeed = () =>
    json({ items: [] }, { headers: { etag: "\"v1\"", "cache-control": "public, max-age=0, s-maxage=3" } });

  it("never lets a shared cache store a response that carries a session cookie", () => {
    const response = finalizeApiResponse(sharedFeed(), ["pc_access=secret; Path=/; HttpOnly; Secure"]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("set-cookie")).toContain("pc_access=secret");
    expect(response.headers.get("etag")).toBe("\"v1\"");
  });

  it("keeps edge-shared responses private on the way to the browser", () => {
    const response = finalizeApiResponse(sharedFeed(), []);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("etag")).toBe("\"v1\"");
  });

  it("leaves no-store responses alone", () => {
    const response = finalizeApiResponse(json({ ok: true }), []);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("works on responses with immutable headers, such as Cache API hits", () => {
    const cached = new Response("{}", { headers: { "cache-control": "public, s-maxage=3" } });
    Object.freeze(cached.headers);
    expect(() => finalizeApiResponse(cached, ["a=b"])).not.toThrow();
  });
});
