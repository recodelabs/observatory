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
