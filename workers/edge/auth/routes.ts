import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { CHALLENGE_TTL_MS } from "../../../packages/shared/constants.ts";
import { bytesToHex, randomToken, sha256 } from "../../../packages/shared/encoding.ts";
import type { Env } from "../env.ts";
import { appendCookies, cookie, HttpError, json, parseCookies, readJson } from "../http.ts";
import { authenticate, createSession, destroySession } from "./session.ts";

const FLOW_COOKIE = "pc_auth_flow";

interface ChallengeRow {
  id: string;
  kind: "register" | "login";
  challenge: string;
  user_id: string | null;
  expires_at: number;
}

interface CredentialRow {
  credential_id: string;
  user_id: string;
  public_key: ArrayBuffer | number[];
  sign_count: number;
  transports: string;
}

export async function handleAuth(request: Request, env: Env, pathname: string): Promise<Response> {
  if (request.method === "GET" && pathname === "/api/auth/session") {
    const auth = await authenticate(request, env);
    const body = auth ? { authenticated: true, author: auth.user.author } : { authenticated: false };
    return appendCookies(json(body), auth?.setCookies ?? []);
  }

  if (request.method === "POST" && pathname === "/api/auth/logout") {
    return appendCookies(json({ ok: true }), await destroySession(request, env));
  }

  if (request.method === "POST" && pathname === "/api/auth/register/options") {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.REGISTER_LIMITER.limit({ key: ip });
    if (!success) throw new HttpError(429, "RATE_LIMITED");
    const flowId = randomToken(18);
    const userId = crypto.randomUUID();
    const options = await generateRegistrationOptions({
      rpName: env.RP_NAME,
      rpID: env.RP_ID,
      userID: Uint8Array.from(new TextEncoder().encode(userId)),
      userName: `nearby-${userId.slice(0, 8)}`,
      userDisplayName: `Nearline ${userId.slice(0, 8)}`,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });
    await saveChallenge(env, flowId, "register", options.challenge, userId);
    return json(options, { headers: { "set-cookie": cookie(FLOW_COOKIE, flowId, CHALLENGE_TTL_MS / 1_000) } });
  }

  if (request.method === "POST" && pathname === "/api/auth/register/verify") {
    const response = await readJson<RegistrationResponseJSON>(request);
    const flow = await consumeChallenge(request, env, "register");
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: flow.challenge,
      expectedOrigin: env.ORIGIN,
      expectedRPID: env.RP_ID,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo || !flow.user_id) {
      throw new HttpError(401, "REGISTRATION_FAILED");
    }
    const credential = verification.registrationInfo.credential;
    const publicKey = new Uint8Array(credential.publicKey);
    const authorHash = bytesToHex(await sha256(publicKey));
    const now = Date.now();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO users (id, author_hash, created_at) VALUES (?, ?, ?)").bind(flow.user_id, authorHash, now),
        env.DB.prepare(
          `INSERT INTO credentials
             (credential_id, user_id, public_key, sign_count, transports, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(credential.id, flow.user_id, publicKey, credential.counter, JSON.stringify(response.response.transports ?? []), now, now),
      ]);
    } catch {
      throw new HttpError(409, "CREDENTIAL_EXISTS");
    }
    const author = authorHash.slice(0, 8);
    return appendCookies(json({ verified: true, author }), await createSession(env, flow.user_id, author));
  }

  if (request.method === "POST" && pathname === "/api/auth/login/options") {
    const flowId = randomToken(18);
    const options = await generateAuthenticationOptions({
      rpID: env.RP_ID,
      userVerification: "required",
      allowCredentials: [],
    });
    await saveChallenge(env, flowId, "login", options.challenge, null);
    return json(options, { headers: { "set-cookie": cookie(FLOW_COOKIE, flowId, CHALLENGE_TTL_MS / 1_000) } });
  }

  if (request.method === "POST" && pathname === "/api/auth/login/verify") {
    const response = await readJson<AuthenticationResponseJSON>(request);
    const flow = await consumeChallenge(request, env, "login");
    const stored = await env.DB.prepare(
      "SELECT credential_id, user_id, public_key, sign_count, transports FROM credentials WHERE credential_id = ?",
    ).bind(response.id).first<CredentialRow>();
    if (!stored) throw new HttpError(401, "UNKNOWN_CREDENTIAL");
    const publicKey = stored.public_key instanceof ArrayBuffer
      ? new Uint8Array(stored.public_key)
      : Uint8Array.from(stored.public_key);
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: flow.challenge,
      expectedOrigin: env.ORIGIN,
      expectedRPID: env.RP_ID,
      requireUserVerification: true,
      credential: {
        id: stored.credential_id,
        publicKey,
        counter: stored.sign_count,
        transports: JSON.parse(stored.transports) as AuthenticatorTransport[],
      },
    });
    if (!verification.verified) throw new HttpError(401, "AUTHENTICATION_FAILED");
    await env.DB.prepare(
      "UPDATE credentials SET sign_count = ?, last_used_at = ? WHERE credential_id = ?",
    ).bind(verification.authenticationInfo.newCounter, Date.now(), stored.credential_id).run();
    const owner = await env.DB.prepare("SELECT author_hash FROM users WHERE id = ?")
      .bind(stored.user_id).first<{ author_hash: string }>();
    if (!owner) throw new HttpError(401, "UNKNOWN_CREDENTIAL");
    return appendCookies(json({ verified: true }), await createSession(env, stored.user_id, owner.author_hash.slice(0, 8)));
  }

  throw new HttpError(404, "NOT_FOUND");
}

async function saveChallenge(
  env: Env,
  id: string,
  kind: "register" | "login",
  challenge: string,
  userId: string | null,
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      "INSERT INTO auth_challenges (id, kind, challenge, user_id, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(id, kind, challenge, userId, now + CHALLENGE_TTL_MS),
  ]);
}

async function consumeChallenge(request: Request, env: Env, kind: ChallengeRow["kind"]): Promise<ChallengeRow> {
  const id = parseCookies(request).get(FLOW_COOKIE);
  if (!id) throw new HttpError(400, "AUTH_FLOW_MISSING");
  const row = await env.DB.prepare(
    "SELECT id, kind, challenge, user_id, expires_at FROM auth_challenges WHERE id = ?",
  ).bind(id).first<ChallengeRow>();
  await env.DB.prepare("DELETE FROM auth_challenges WHERE id = ?").bind(id).run();
  if (!row || row.kind !== kind || row.expires_at <= Date.now()) throw new HttpError(400, "AUTH_FLOW_EXPIRED");
  return row;
}
