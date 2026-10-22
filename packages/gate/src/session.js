import {jwtPayload, claimsRow} from "./auth.js";

export class SessionUnavailable extends Error {
  constructor(cause) { super("session storage unavailable"); this.cause = cause; }
}

/**
 * Returns {user, session} or null. Any storage failure throws SessionUnavailable so the
 * caller fails closed.
 *
 * Better Auth's getSession swallows storage errors and answers null, which is
 * indistinguishable from "no session" — and null is the answer that would let a broken
 * database look like a logged-out visitor. So a null answer is confirmed with a cheap
 * probe against the session table itself: if storage is unreachable (or the table is
 * gone) the probe throws and we report the outage instead. A generic `select 1` would not
 * catch this — it never touches a table, so it still succeeds even when the session table
 * is missing. A successful getSession already proves storage works, so the probe pays
 * nothing in that path.
 */
export async function readSession(auth, request) {
  if (!request.headers.get("cookie")) return null;
  try {
    const got = await auth.api.getSession({headers: request.headers});
    if (!got) await auth.db.selectFrom("session").select("id").limit(1).execute();
    return got ?? null;
  } catch (err) {
    throw new SessionUnavailable(err);
  }
}

/**
 * The signed-in user as the access rules see them: {user, session, provider, claims}, or null.
 *
 * `provider` is how the session was signed in: "email", or an OIDC provider id; an OIDC session
 * also names its provider account (`session.subject`, auth.js). `claims` maps that one provider
 * to the {groups, roles} stored for that one account; an email session gets none, even if the
 * same user also has a Keycloak account.
 *
 * An OIDC session ends (and null is returned) when:
 *   - it is older than auth.oidcSessionHours, however much it was used;
 *   - its provider is no longer in the config, or its account or claims are gone;
 *   - its claims are older than auth.claimsMaxAge and the refresh with the provider's refresh
 *     token fails (the user was disabled or signed out in Keycloak). The account's claims are
 *     then deleted, so every session of that account ends at its next request.
 * A refresh stores the groups from the newly issued access token (Keycloak's mappers put them
 * there), never from tokens kept from before; a token without the account's subject fails it.
 * Of several requests that find the claims stale, one refreshes and the others wait for it (up
 * to a few seconds; if it doesn't finish, they're refused rather than served on old claims).
 */
export async function readWho(auth, config, request, env, {wait = sleep} = {}) {
  const got = await readSession(auth, request);
  if (!got) return null;
  const provider = got.session.provider || "email";
  if (provider === "email") return {...got, provider, claims: new Map()};
  try {
    const p = config.auth.oidc.find((x) => x.id === provider);
    const subject = got.session.subject;
    const started = new Date(got.session.createdAt).getTime();
    if (!p || !subject || !(Date.now() - started < config.auth.oidcSessionHours * 3600e3)) return endSession(auth, got);
    const maxAge = config.auth.claimsMaxAge * 1000;
    let row = await claimsOf(auth.db, provider, subject);
    if (!row || row.userId !== got.user.id) return endSession(auth, got);
    if (Date.now() - Number(row.refreshedAt) > maxAge) {
      const now = Date.now();
      const lock = crypto.randomUUID();
      const won = await auth.db.updateTable("oidcClaims").set({refreshingUntil: now + 10e3, refreshLock: lock})
        .where("providerId", "=", provider).where("subject", "=", subject)
        .where("refreshedAt", "=", row.refreshedAt).where("refreshingUntil", "<", now)
        .executeTakeFirst();
      if (Number(won.numUpdatedRows) === 1) {
        const result = await refresh(auth, env, p, got, subject, lock);
        if (result === "failed") return endSession(auth, got);
        if (result === "superseded") return null;   // a sign-in or a later refresh wrote first: refuse this request only
        row = result;
      } else {
        row = null;
        for (let i = 0; i < 10 && !row; i++) {
          await wait(400);
          const now2 = await claimsOf(auth.db, provider, subject);
          if (!now2) return endSession(auth, got);
          if (Date.now() - Number(now2.refreshedAt) <= maxAge) row = now2;
        }
        if (!row) return null;   // the refresh didn't finish in time: refuse this request, keep the session
      }
    }
    return {...got, provider, claims: new Map([[provider, {groups: JSON.parse(row.groups), roles: JSON.parse(row.roles)}]])};
  } catch (err) {
    if (err instanceof SessionUnavailable) throw err;
    throw new SessionUnavailable(err);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Refresh one account's tokens at the provider and store the claims from the new access token.
 * Returns the new row, "failed", or "superseded" when the lock was lost meanwhile (a sign-in
 * stored newer claims, or the lock ran out and another refresh took it).
 *
 * The gate calls the provider's token endpoint itself, rather than Better Auth's refresh, so that
 * nothing is written until it knows it still holds the lock. The writes are one D1 batch (one
 * transaction), each statement conditional on that lock:
 *   - success: the claims, then the account's tokens, then the lock released;
 *   - failure: every session of the account, then its claims.
 * A sign-in in between clears the lock (auth.js, saveClaims), so its tokens, claims and new
 * session are never overwritten or deleted by an older refresh.
 */
// Better Auth keeps provider tokens unencrypted in D1 here (account.encryptOAuthTokens is off), so
// the refresh token is read as stored.
async function refresh(auth, env, p, got, subject, lock) {
  const account = await auth.db.selectFrom("account").select(["id", "refreshToken"])
    .where("userId", "=", got.user.id).where("providerId", "=", p.id).where("accountId", "=", subject)
    .executeTakeFirst();
  let tokens = null, claims = null;
  if (account?.refreshToken) {
    try {
      tokens = await refreshAtProvider(p, env[p.secretName], account.refreshToken);
      claims = jwtPayload(tokens.access_token);
    } catch {
      tokens = null;
    }
  }
  const owned = `EXISTS (SELECT 1 FROM "oidcClaims" WHERE "providerId" = ? AND "subject" = ? AND "refreshLock" = ?)`;
  if (!tokens || !claims || claims.sub !== subject) {
    const [, gone] = await env.DB.batch([
      env.DB.prepare(`DELETE FROM "session" WHERE "provider" = ? AND "subject" = ? AND ${owned}`).bind(p.id, subject, p.id, subject, lock),
      env.DB.prepare(`DELETE FROM "oidcClaims" WHERE "providerId" = ? AND "subject" = ? AND "refreshLock" = ?`).bind(p.id, subject, lock)
    ]);
    return gone.meta.changes === 1 ? "failed" : "superseded";
  }
  const row = claimsRow(p.id, subject, got.user.id, claims);
  const done = `${lock}:done`;
  const now = new Date().toISOString();
  const [saved] = await env.DB.batch([
    env.DB.prepare(`UPDATE "oidcClaims" SET "groups" = ?, "roles" = ?, "refreshedAt" = ?, "refreshingUntil" = 0, "refreshLock" = ?
      WHERE "providerId" = ? AND "subject" = ? AND "refreshLock" = ?`).bind(row.groups, row.roles, row.refreshedAt, done, p.id, subject, lock),
    env.DB.prepare(`UPDATE "account" SET "accessToken" = ?, "refreshToken" = ?, "idToken" = COALESCE(?, "idToken"),
      "accessTokenExpiresAt" = ?, "updatedAt" = ? WHERE "id" = ? AND ${owned}`)
      .bind(tokens.access_token, tokens.refresh_token ?? account.refreshToken, tokens.id_token ?? null,
        tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null, now, account.id, p.id, subject, done),
    env.DB.prepare(`UPDATE "oidcClaims" SET "refreshLock" = NULL WHERE "providerId" = ? AND "subject" = ? AND "refreshLock" = ?`).bind(p.id, subject, done)
  ]);
  return saved.meta.changes === 1 ? row : "superseded";
}

// The provider's token endpoint, from its discovery document (kept for the isolate's life).
const tokenEndpoints = new Map();
async function tokenEndpoint(p) {
  if (!tokenEndpoints.has(p.issuer)) {
    const res = await fetch(`${p.issuer}/.well-known/openid-configuration`, {signal: AbortSignal.timeout(5000)});
    if (!res.ok) throw new Error(`discovery ${res.status}`);
    const {token_endpoint: url} = await res.json();
    if (!url || !String(url).startsWith(p.issuer + "/")) throw new Error("token endpoint outside the issuer");
    tokenEndpoints.set(p.issuer, url);
  }
  return tokenEndpoints.get(p.issuer);
}

async function refreshAtProvider(p, secret, refreshToken) {
  const res = await fetch(await tokenEndpoint(p), {
    method: "POST",
    headers: {"content-type": "application/x-www-form-urlencoded", accept: "application/json"},
    body: new URLSearchParams({grant_type: "refresh_token", refresh_token: refreshToken, client_id: p.clientId, client_secret: secret}).toString(),
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`token endpoint ${res.status}`);
  const tokens = await res.json();
  if (typeof tokens?.access_token !== "string") throw new Error("no access token");
  return tokens;
}

function claimsOf(db, providerId, subject) {
  return db.selectFrom("oidcClaims").selectAll().where("providerId", "=", providerId).where("subject", "=", subject).executeTakeFirst();
}

async function endSession(auth, got) {
  await auth.db.deleteFrom("session").where("id", "=", got.session.id).execute();
  return null;
}
