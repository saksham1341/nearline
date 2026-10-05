import { base64urlToBytes, bytesToBase64url } from "./encoding.ts";

export interface AccessPayload {
  uid: string;
  author: string;
  sid: string;
  exp: number;
}

const encoder = new TextEncoder();

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** `base64url(json) "." base64url(HMAC-SHA256(secret, base64url(json)))` — verifiable with no storage access. */
export async function signAccessToken(payload: AccessPayload, secret: string): Promise<string> {
  const body = bytesToBase64url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body)));
  return `${body}.${bytesToBase64url(signature)}`;
}

export async function verifyAccessToken(token: string, secret: string, now: number): Promise<AccessPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts as [string, string];
  try {
    // crypto.subtle.verify compares in constant time.
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      new Uint8Array(base64urlToBytes(signature)),
      encoder.encode(body),
    );
    if (!valid) return null;
    const payload: unknown = JSON.parse(new TextDecoder().decode(base64urlToBytes(body)));
    return isPayload(payload) && payload.exp > now ? payload : null;
  } catch {
    return null;
  }
}

function isPayload(value: unknown): value is AccessPayload {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<AccessPayload>;
  return typeof item.uid === "string" && typeof item.author === "string"
    && typeof item.sid === "string" && typeof item.exp === "number";
}
