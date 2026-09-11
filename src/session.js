import {sql} from "kysely";

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
 * probe through the same D1 binding: if the database is unreachable the probe throws and
 * we report the outage instead. A successful getSession already proves storage works, so
 * it pays nothing.
 */
export async function readSession(auth, request) {
  if (!request.headers.get("cookie")) return null;
  try {
    const got = await auth.api.getSession({headers: request.headers});
    if (!got) await sql`select 1`.execute(auth.db);
    return got ?? null;
  } catch (err) {
    throw new SessionUnavailable(err);
  }
}
