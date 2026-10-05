import { describe, expect, it } from "vitest";
import { signAccessToken, verifyAccessToken } from "../packages/shared/session-token.ts";

const payload = { uid: "user-1", author: "abcd1234", sid: "0123456789abcdef", exp: 10_000 };

describe("access tokens", () => {
  it("round-trips a payload before expiry", async () => {
    const token = await signAccessToken(payload, "secret");
    expect(await verifyAccessToken(token, "secret", 9_999)).toEqual(payload);
  });

  it("rejects expired, tampered, re-keyed and malformed tokens", async () => {
    const token = await signAccessToken(payload, "secret");
    expect(await verifyAccessToken(token, "secret", 10_000)).toBeNull();
    expect(await verifyAccessToken(token, "other", 1)).toBeNull();
    const [body, signature] = token.split(".");
    const forged = btoa(JSON.stringify({ ...payload, uid: "admin" })).replaceAll("=", "");
    expect(await verifyAccessToken(`${forged}.${signature}`, "secret", 1)).toBeNull();
    expect(await verifyAccessToken(`${body}`, "secret", 1)).toBeNull();
    expect(await verifyAccessToken(`${token}.extra`, "secret", 1)).toBeNull();
    expect(await verifyAccessToken("!!!.???", "secret", 1)).toBeNull();
  });
});
