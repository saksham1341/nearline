import { SESSION_TTL_MS } from "../../../packages/shared/constants.ts";
import { bytesToHex, randomToken, sha256 } from "../../../packages/shared/encoding.ts";
import type { AuthenticatedUser, Env } from "../env.ts";
import { cookie, parseCookies } from "../http.ts";

const SESSION_COOKIE = "pc_session";

export async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomToken();
  const tokenHash = bytesToHex(await sha256(token));
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  ).bind(tokenHash, userId, now + SESSION_TTL_MS, now).run();
  return cookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1_000);
}

export async function authenticate(request: Request, env: Env): Promise<AuthenticatedUser | null> {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = bytesToHex(await sha256(token));
  const row = await env.DB.prepare(
    `SELECT users.id, users.author_hash
       FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
  ).bind(tokenHash, Date.now()).first<{ id: string; author_hash: string }>();
  return row ? { id: row.id, authorHash: row.author_hash } : null;
}

export async function destroySession(request: Request, env: Env): Promise<string> {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (token) {
    const tokenHash = bytesToHex(await sha256(token));
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }
  return cookie(SESSION_COOKIE, "", 0);
}
