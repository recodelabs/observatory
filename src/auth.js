import {betterAuth} from "better-auth";
import {magicLink} from "better-auth/plugins/magic-link";
import {admin} from "better-auth/plugins/admin";
import {Kysely} from "kysely";
import {D1Dialect} from "kysely-d1";
import {sendMail} from "./mail.js";

/** One Better Auth instance per request: Workers only expose bindings at request time. */
export function createAuth(env, config) {
  const db = new Kysely({dialect: new D1Dialect({database: env.DB})});
  const auth = betterAuth({
    baseURL: env.BASE_URL,
    basePath: "/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: {db, type: "sqlite"},
    trustedOrigins: [env.BASE_URL],
    // D1 forbids reading sqlite_master, so Better Auth's startup introspection can never
    // succeed here; leaving it on only logs an error on every request. Schema drift is
    // caught by migrations/0001_auth.sql instead.
    advanced: {
      database: {validateSchema: false},
      // Cloudflare sets cf-connecting-ip on every edge request; without it the rate
      // limiter buckets the whole world into one counter per path.
      ipAddress: {ipAddressHeaders: ["cf-connecting-ip"]}
    },
    emailAndPassword: {enabled: true, minPasswordLength: 10, autoSignIn: true},
    session: {expiresIn: config.auth.sessionDays * 24 * 60 * 60, updateAge: 24 * 60 * 60},
    rateLimit: {enabled: true, storage: "database", window: 60, max: 60,
      customRules: {"/sign-in/email": {window: 60, max: 10}, "/sign-in/magic-link": {window: 60, max: 5}, "/sign-up/email": {window: 60, max: 5}}},
    user: {
      additionalFields: {
        status: {type: "string", required: false, defaultValue: "pending", input: false}
      }
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const {n} = await db.selectFrom("user").select((eb) => eb.fn.countAll().as("n")).executeTakeFirst();
            const first = Number(n) === 0;
            const domain = String(user.email).toLowerCase().split("@")[1] ?? "";
            const allowlisted = config.auth.allowedDomains.includes(domain);
            return {data: {...user, role: first ? "admin" : "user", status: first || allowlisted ? "active" : "pending"}};
          },
          after: async (user) => {
            if (user.status === "pending" && config.mail.adminNotify) {
              await sendMail(env, config, {to: config.mail.adminNotify, subject: `${config.brand.title}: new account waiting for approval`,
                text: `${user.email} signed up and is waiting for approval.\n\n${env.BASE_URL}/_door/admin`});
            }
          }
        }
      }
    },
    plugins: [
      admin({defaultRole: "user", adminRoles: ["admin"]}),
      magicLink({
        disableSignUp: true,
        sendMagicLink: async ({email, url}) => {
          await sendMail(env, config, {to: email, subject: `Sign in to ${config.brand.title}`, text: `Click to sign in:\n\n${url}\n\nThis link expires in 5 minutes.`});
        }
      })
    ]
  });
  return Object.assign(auth, {db});
}
