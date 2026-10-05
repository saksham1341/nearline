import type { ErrorCode } from "../../../packages/protocol/index.ts";
import { bytesToHex, sha256 } from "../../../packages/shared/encoding.ts";
import { json } from "../http.ts";

/** Cache API keys live on a private origin so they can never collide with real URLs. */
export const CACHE_ORIGIN = "https://cache.nearline.internal";

export function errorJson(status: number, code: ErrorCode): Response {
  return json({ error: code }, { status });
}

export function statusFor(code: ErrorCode): number {
  switch (code) {
    case "UNAUTHORIZED": return 401;
    case "FORBIDDEN_ORIGIN":
    case "NOT_VISIBLE":
    case "NOT_AUTHOR": return 403;
    case "THREAD_NOT_FOUND":
    case "PARENT_NOT_FOUND":
    case "POST_NOT_FOUND": return 404;
    case "ALREADY_REPOSTED":
    case "THREAD_FULL": return 409;
    case "THREAD_EXPIRED": return 410;
    case "RATE_LIMITED": return 429;
    case "UNAVAILABLE": return 503;
    default: return 400;
  }
}

export function sharedCacheControl(seconds: number): string {
  return `public, max-age=0, s-maxage=${seconds}`;
}

/**
 * Answers 304 when the client already has this version. If-None-Match uses weak comparison
 * (RFC 9110 §13.1.2): Cloudflare marks ETags weak when it compresses, so `W/` must not matter.
 */
export function conditional(request: Request, response: Response): Response {
  const etag = response.headers.get("etag");
  const header = request.headers.get("if-none-match");
  if (etag && header && matchesWeakly(header, etag)) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": response.headers.get("cache-control") ?? "no-store" } });
  }
  return response;
}

function matchesWeakly(header: string, etag: string): boolean {
  if (header.trim() === "*") return true;
  const opaque = (tag: string) => tag.trim().replace(/^W\//u, "");
  const target = opaque(etag);
  return header.split(",").some((candidate) => opaque(candidate) === target);
}

export async function versionHash(parts: readonly (string | number)[]): Promise<string> {
  return bytesToHex(await sha256(parts.join("|"))).slice(0, 16);
}
