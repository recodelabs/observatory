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
  for (const u of users) {
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

/** Delete a user with their sessions and sign-in accounts. */
export async function deleteUser(db, userId) {
  await db.deleteFrom("session").where("userId", "=", userId).execute();
  await db.deleteFrom("account").where("userId", "=", userId).execute();
  await db.deleteFrom("user").where("id", "=", userId).execute();
}
