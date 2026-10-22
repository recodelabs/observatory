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
 * `provider` is how the session was signed in: "email", or an OIDC provider id (auth.js stamps
 * it on the session). `claims` maps that one provider to the {groups, roles} stored from its
 * tokens; an email session gets none, even if the same user also has a Keycloak account.
 *
 * An OIDC session ends (and null is returned) when:
 *   - it is older than auth.oidcSessionHours, however much it was used;
 *   - its provider is no longer in the config, or no claims were stored for it;
 *   - its claims are older than auth.claimsMaxAge and the refresh with the provider's refresh
 *     token fails (the user was disabled or signed out in Keycloak).
 * A refresh rewrites the claims from the new tokens (auth.js), so a user taken out of a group
 * loses that group's access within claimsMaxAge. Of several requests that find the claims stale
 * at once, one refreshes; the others go on with the claims they read.
 */
export async function readWho(auth, config, request) {
  const got = await readSession(auth, request);
  if (!got) return null;
  const provider = got.session.provider || "email";
  if (provider === "email") return {...got, provider, claims: new Map()};
  try {
    const p = config.auth.oidc.find((x) => x.id === provider);
    const started = new Date(got.session.createdAt).getTime();
    if (!p || !(Date.now() - started < config.auth.oidcSessionHours * 3600e3)) return endSession(auth, got);
    let row = await claimsOf(auth.db, provider, got.user.id);
    if (!row) return endSession(auth, got);
    if (Date.now() - Number(row.refreshedAt) > config.auth.claimsMaxAge * 1000) {
      const won = await auth.db.updateTable("oidcClaims").set({refreshedAt: Date.now()})
        .where("providerId", "=", provider).where("subject", "=", row.subject).where("refreshedAt", "=", row.refreshedAt)
        .executeTakeFirst();
      if (Number(won.numUpdatedRows) === 1) {
        const account = await auth.db.selectFrom("account").select("id")
          .where("userId", "=", got.user.id).where("providerId", "=", provider).executeTakeFirst();
        try {
          if (!account) throw new Error("no account");
          await auth.api.refreshToken({body: {accountId: account.id, userId: got.user.id}});
        } catch {
          return endSession(auth, got);
        }
        row = await claimsOf(auth.db, provider, got.user.id);
        if (!row) return endSession(auth, got);
      }
    }
    return {...got, provider, claims: new Map([[provider, {groups: JSON.parse(row.groups), roles: JSON.parse(row.roles)}]])};
  } catch (err) {
    if (err instanceof SessionUnavailable) throw err;
    throw new SessionUnavailable(err);
  }
}

function claimsOf(db, providerId, userId) {
  return db.selectFrom("oidcClaims").selectAll().where("providerId", "=", providerId).where("userId", "=", userId).executeTakeFirst();
}

async function endSession(auth, got) {
  await auth.db.deleteFrom("session").where("id", "=", got.session.id).execute();
  return null;
}
