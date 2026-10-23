import {Kysely} from "kysely";
import {D1Dialect} from "kysely-d1";

export const dbFor = (env) => new Kysely({dialect: new D1Dialect({database: env.DB})});

export async function listUsers(db) {
  const users = await db.selectFrom("user")
    .leftJoin("session", "session.userId", "user.id")
    .select(["user.id", "user.email", "user.emailVerified", "user.name", "user.role", "user.status", "user.createdAt",
      (eb) => eb.fn.max("session.createdAt").as("lastSignIn")])
    .groupBy("user.id").orderBy("user.createdAt", "desc").execute();
  // How each user signs in ("credential" is Better Auth's name for a password), and the
  // Keycloak groups stored for them.
  const accounts = await db.selectFrom("account").select(["userId", "providerId"]).execute();
  const claims = await db.selectFrom("oidcClaims").select(["userId", "providerId", "groups"]).execute();
  const grants = await db.selectFrom("siteGrant").select(["userId", "site"]).execute();
  for (const u of users) {
    u.sites = grants.filter((g) => g.userId === u.id).map((g) => g.site);
    u.providers = accounts.filter((a) => a.userId === u.id).map((a) => a.providerId === "credential" ? "password" : a.providerId);
    u.groups = claims.filter((c) => c.userId === u.id).flatMap((c) => JSON.parse(c.groups).map((g) => `${c.providerId}:${g}`));
  }
  return users;
}

export async function setStatus(db, userId, status) {
  // D1's binder rejects a Date object outright ("Type 'object' not supported"); the other
  // date columns Better Auth writes are ISO strings, so match that rather than a Date.
  await db.updateTable("user").set({status, updatedAt: new Date().toISOString()}).where("id", "=", userId).execute();
}

export async function getUser(db, userId) {
  return db.selectFrom("user").selectAll().where("id", "=", userId).executeTakeFirst();
}


export async function setRole(db, userId, role) {
  await db.updateTable("user").set({role, updatedAt: new Date().toISOString()}).where("id", "=", userId).execute();
}

export async function getUserByEmail(db, email) {
  return db.selectFrom("user").selectAll().where("email", "=", email).executeTakeFirst();
}

/**
 * Create an invited user: active, so they can sign in at once with an emailed link (following
 * it confirms the address), and with no password. Returns the new user's id.
 */
export async function createInvitedUser(db, {email, name, role}) {
  const id = crypto.randomUUID().replaceAll("-", "");
  const now = new Date().toISOString();
  await db.insertInto("user").values({id, email, name: name || email, emailVerified: 0, createdAt: now, updatedAt: now,
    role, status: "active"}).execute();
  return id;
}

/**
 * Replace the sites an admin has granted a user with `sites` (site names), in one D1 batch, so
 * two admins saving at once leave one of their choices rather than both mixed. `d1` is the D1
 * binding (env.DB).
 */
export async function setSites(d1, userId, sites, by) {
  const now = new Date().toISOString();
  await d1.batch([
    d1.prepare(`DELETE FROM "siteGrant" WHERE "userId" = ?`).bind(userId),
    ...sites.map((site) => d1.prepare(`INSERT INTO "siteGrant" ("userId", "site", "createdAt", "createdBy") VALUES (?, ?, ?, ?)`)
      .bind(userId, site, now, by))
  ]);
}

/** Add sites to the ones a user has been granted. */
export async function addSites(d1, userId, sites, by) {
  if (!sites.length) return;
  const now = new Date().toISOString();
  await d1.batch(sites.map((site) => d1.prepare(
    `INSERT INTO "siteGrant" ("userId", "site", "createdAt", "createdBy") VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .bind(userId, site, now, by)));
}

/**
 * Replace an account whose address isn't confirmed with a new, invited one (active, no password,
 * a new id), in one D1 batch. Returns the new id.
 *
 * Anyone can sign up with someone else's address, so until it is confirmed, the account's
 * password, sessions and sign-in accounts may be a stranger's. Deleting the old user takes all of
 * them with it (and its grants). A sign-in already under way when this runs read the old
 * credentials, but the session it then writes names the old id, which no longer exists: the
 * insert fails on the foreign key, so it can't land on the new account. The new account can only
 * be signed into with an emailed link, which confirms the address.
 */
// Every delete is conditional on the old account still being unconfirmed and not disabled, so
// one confirmed or disabled in the meantime is left whole (a disabled user stays disabled).
const UNCONFIRMED = `EXISTS (SELECT 1 FROM "user" WHERE "id" = ? AND "emailVerified" = 0 AND "status" != 'disabled')`;

export async function replaceUnconfirmed(d1, old, {name, role}) {
  const id = crypto.randomUUID().replaceAll("-", "");
  const now = new Date().toISOString();
  await d1.batch([
    d1.prepare(`DELETE FROM "siteGrant" WHERE "userId" = ? AND ${UNCONFIRMED}`).bind(old.id, old.id),
    d1.prepare(`DELETE FROM "session" WHERE "userId" = ? AND ${UNCONFIRMED}`).bind(old.id, old.id),
    d1.prepare(`DELETE FROM "account" WHERE "userId" = ? AND ${UNCONFIRMED}`).bind(old.id, old.id),
    d1.prepare(`DELETE FROM "oidcClaims" WHERE "userId" = ? AND ${UNCONFIRMED}`).bind(old.id, old.id),
    d1.prepare(`DELETE FROM "user" WHERE "id" = ? AND "emailVerified" = 0 AND "status" != 'disabled'`).bind(old.id),
    // Only if the delete happened: if the address was confirmed, or the account disabled, in the
    // meantime, nothing changes.
    d1.prepare(`INSERT INTO "user" ("id", "email", "name", "emailVerified", "createdAt", "updatedAt", "role", "status")
      SELECT ?, ?, ?, 0, ?, ?, ?, 'active' WHERE NOT EXISTS (SELECT 1 FROM "user" WHERE "email" = ?)`)
      .bind(id, old.email, name || old.email, now, now, role, old.email)
  ]);
  return id;
}

/**
 * An invitation's changes to an existing account, in one D1 batch, each conditional on the
 * account as stored at that moment: a pending account becomes active, an admin invitation makes
 * it an admin, and the ticked sites are added, none of it if the account is disabled by then.
 * (The caller has already refused a disabled account; this covers one disabled in between.)
 */
export async function inviteExisting(d1, userId, {makeAdmin, sites, by}) {
  const now = new Date().toISOString();
  const enabled = `EXISTS (SELECT 1 FROM "user" WHERE "id" = ? AND "status" != 'disabled')`;
  await d1.batch([
    d1.prepare(`UPDATE "user" SET "status" = 'active', "updatedAt" = ? WHERE "id" = ? AND "status" = 'pending'`).bind(now, userId),
    ...(makeAdmin ? [d1.prepare(`UPDATE "user" SET "role" = 'admin', "updatedAt" = ? WHERE "id" = ? AND "status" != 'disabled'`).bind(now, userId)] : []),
    ...sites.map((site) => d1.prepare(`INSERT INTO "siteGrant" ("userId", "site", "createdAt", "createdBy")
      SELECT ?, ?, ?, ? WHERE ${enabled} ON CONFLICT DO NOTHING`).bind(userId, site, now, by, userId))
  ]);
}

/** Delete a user with their sessions, sign-in accounts and site grants. */
export async function deleteUser(db, userId) {
  await db.deleteFrom("siteGrant").where("userId", "=", userId).execute();
  await db.deleteFrom("session").where("userId", "=", userId).execute();
  await db.deleteFrom("account").where("userId", "=", userId).execute();
  await db.deleteFrom("user").where("id", "=", userId).execute();
}
