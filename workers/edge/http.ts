export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

/** Adds Set-Cookie headers. A response carrying a cookie must never be stored by a shared cache. */
export function appendCookies(response: Response, cookies: readonly string[]): Response {
  if (cookies.length === 0) return response;
  const copy = new Response(response.body, response);
  copy.headers.set("cache-control", "private, no-store");
  for (const cookie of cookies) copy.headers.append("set-cookie", cookie);
  return copy;
}

/**
 * Prepares an API response for the browser. Feed and thread responses are marked `public` so the
 * Worker's own edge cache can share them; on the way out they become private, so no proxy between
 * Cloudflare and the browser stores them. Any response carrying a session cookie is never stored.
 */
export function finalizeApiResponse(response: Response, cookies: readonly string[]): Response {
  const copy = new Response(response.body, response);
  if ((copy.headers.get("cache-control") ?? "").includes("public")) copy.headers.set("cache-control", "private, no-cache");
  if (cookies.length === 0) return copy;
  copy.headers.set("cache-control", "private, no-store");
  for (const cookie of cookies) copy.headers.append("set-cookie", cookie);
  return copy;
}

export async function readJson<T>(request: Request): Promise<T> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "JSON_REQUIRED");
  }
  try {
    return await request.json<T>();
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }
}

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: error.code }, { status: error.status });
  console.error(error);
  return json({ error: "INTERNAL_ERROR" }, { status: 500 });
}

export function parseCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const entry of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    cookies.set(entry.slice(0, separator).trim(), entry.slice(separator + 1).trim());
  }
  return cookies;
}

export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}
