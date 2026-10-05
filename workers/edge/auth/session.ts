import { ACCESS_TOKEN_TTL_MS, SESSION_TTL_MS } from "../../../packages/shared/constants.ts";
import { bytesToHex, randomToken, sha256 } from "../../../packages/shared/encoding.ts";
import { signAccessToken, verifyAccessToken } from "../../../packages/shared/session-token.ts";
import type { ApiUser } from "../api/context.ts";
import type { Env } from "../env.ts";
import { cookie, parseCookies } from "../http.ts";

const MIN_SESSION_KEY_LENGTH = 32;
const SESSION_COOKIE = "pc_session";
const ACCESS_COOKIE = "pc_access";

export interface AuthResult {
  user: ApiUser;
  /** Set-Cookie values the response must carry (a refreshed access token). */
  setCookies: string[];
}

export async function createSession(
  env: Pick<Env, "DB" | "SESSION_KEY">,
  userId: string,
  author: string,
  now = Date.now(),
): Promise<string[]> {
  sessionKey(env);
  const token = randomToken();
  const tokenHash = bytesToHex(await sha256(token));
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  ).bind(tokenHash, userId, now + SESSION_TTL_MS, now).run();
  return [
    cookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1_000),
    await accessCookie(env, { id: userId, author }, tokenHash, now),
  ];
}

/**
 * The access token is checked with no storage access, so polls never touch D1. When it is missing
 * or expired, the refresh session in D1 is checked and a new access token issued: at most one D1
 * read per user per hour.
 */
export async function authenticate(
  request: Request,
  env: Pick<Env, "DB" | "SESSION_KEY">,
  now = Date.now(),
): Promise<AuthResult | null> {
  const key = sessionKey(env);
  const cookies = parseCookies(request);
  const access = cookies.get(ACCESS_COOKIE);
  if (access) {
    const payload = await verifyAccessToken(access, key, now);
    if (payload) return { user: { id: payload.uid, author: payload.author }, setCookies: [] };
  }
  const token = cookies.get(SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = bytesToHex(await sha256(token));
  const row = await env.DB.prepare(
    `SELECT users.id, users.author_hash
       FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
  ).bind(tokenHash, now).first<{ id: string; author_hash: string }>();
  if (!row) return null;
  const user = { id: row.id, author: row.author_hash.slice(0, 8) };
  return { user, setCookies: [await accessCookie(env, user, tokenHash, now)] };
}

/** An access token stays valid until it expires (at most an hour): the cost of stateless checks. */
export async function destroySession(request: Request, env: Pick<Env, "DB">): Promise<string[]> {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (token) {
    const tokenHash = bytesToHex(await sha256(token));
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }
  return [cookie(SESSION_COOKIE, "", 0), cookie(ACCESS_COOKIE, "", 0)];
}

async function accessCookie(env: Pick<Env, "SESSION_KEY">, user: ApiUser, tokenHash: string, now: number): Promise<string> {
  const token = await signAccessToken(
    { uid: user.id, author: user.author, sid: tokenHash.slice(0, 16), exp: now + ACCESS_TOKEN_TTL_MS },
    sessionKey(env),
  );
  return cookie(ACCESS_COOKIE, token, ACCESS_TOKEN_TTL_MS / 1_000);
}

/** Fails closed: without a strong key, no token is issued or accepted. */
function sessionKey(env: Pick<Env, "SESSION_KEY">): string {
  const key = env.SESSION_KEY;
  if (typeof key !== "string" || key.length < MIN_SESSION_KEY_LENGTH) {
    throw new Error(`SESSION_KEY is missing or shorter than ${MIN_SESSION_KEY_LENGTH} characters`);
  }
  return key;
}
