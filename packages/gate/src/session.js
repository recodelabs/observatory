import {jwtPayload, claimsRow, saveClaims} from "./auth.js";

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
export async function readWho(auth, config, request, {wait = sleep} = {}) {
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
        const result = await refresh(auth, got, provider, subject, lock);
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
 * Refresh one account's tokens and store its claims from the new access token. Returns the new
 * row, "failed", or "superseded" when the lock was lost meanwhile (a sign-in stored newer claims,
 * or the lock ran out and another refresh took it): then nothing is written.
 */
async function refresh(auth, got, provider, subject, lock) {
  const account = await auth.db.selectFrom("account").select("id")
    .where("userId", "=", got.user.id).where("providerId", "=", provider).where("accountId", "=", subject)
    .executeTakeFirst();
  let claims = null;
  if (account) {
    try {
      const tokens = await auth.api.refreshToken({body: {accountId: account.id, userId: got.user.id}});
      claims = jwtPayload(tokens?.accessToken);
    } catch {
      claims = null;
    }
  }
  const mine = (q) => q.where("providerId", "=", provider).where("subject", "=", subject).where("refreshLock", "=", lock);
  if (!claims || claims.sub !== subject) {
    // Fail closed for the whole account: its claims go, and every session bound to it ends now,
    // so a later sign-in that stores claims again can't bring those sessions back.
    const gone = await mine(auth.db.deleteFrom("oidcClaims")).executeTakeFirst();
    if (Number(gone.numDeletedRows) !== 1) return "superseded";
    await auth.db.deleteFrom("session").where("provider", "=", provider).where("subject", "=", subject).execute();
    return "failed";
  }
  const row = claimsRow(provider, subject, got.user.id, claims);
  const saved = await mine(auth.db.updateTable("oidcClaims").set({groups: row.groups, roles: row.roles,
    refreshedAt: row.refreshedAt, refreshingUntil: 0, refreshLock: null})).executeTakeFirst();
  return Number(saved.numUpdatedRows) === 1 ? row : "superseded";
}

function claimsOf(db, providerId, subject) {
  return db.selectFrom("oidcClaims").selectAll().where("providerId", "=", providerId).where("subject", "=", subject).executeTakeFirst();
}

async function endSession(auth, got) {
  await auth.db.deleteFrom("session").where("id", "=", got.session.id).execute();
  return null;
}
