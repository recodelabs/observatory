import {Kysely} from "kysely";
import {D1Dialect} from "kysely-d1";

export const dbFor = (env) => new Kysely({dialect: new D1Dialect({database: env.DB})});

export async function listUsers(db) {
  return db.selectFrom("user")
    .leftJoin("session", "session.userId", "user.id")
    .select(["user.id", "user.email", "user.name", "user.role", "user.status", "user.createdAt",
      (eb) => eb.fn.max("session.createdAt").as("lastSignIn")])
    .groupBy("user.id").orderBy("user.createdAt", "desc").execute();
}

export async function setStatus(db, userId, status) {
  // D1's binder rejects a Date object outright ("Type 'object' not supported"); the other
  // date columns Better Auth writes are ISO strings, so match that rather than a Date.
  await db.updateTable("user").set({status, updatedAt: new Date().toISOString()}).where("id", "=", userId).execute();
}

export async function getUser(db, userId) {
  return db.selectFrom("user").selectAll().where("id", "=", userId).executeTakeFirst();
}

export async function countAdmins(db) {
  const {n} = await db.selectFrom("user").select((eb) => eb.fn.countAll().as("n")).where("role", "=", "admin").executeTakeFirst();
  return Number(n);
}
