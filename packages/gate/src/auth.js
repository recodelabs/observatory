import {betterAuth} from "better-auth";
import {magicLink} from "better-auth/plugins/magic-link";
import {admin} from "better-auth/plugins/admin";
import {genericOAuth} from "better-auth/plugins/generic-oauth";
import {Kysely} from "kysely";
import {D1Dialect} from "kysely-d1";
import {sendMail, MailError} from "./mail.js";

/** The payload of a JWT, unverified (the caller trusts where the token came from), or null. */
export function jwtPayload(token) {
  try {
    const part = String(token).split(".")[1];
    const json = atob(part.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (ch) => ch.charCodeAt(0))));
  } catch {
    return null;
  }
}

const strings = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];

/** The groups and realm roles in a token's claims, as stored. */
export function claimsRow(providerId, subject, userId, claims) {
  return {providerId, subject, userId, groups: JSON.stringify(strings(claims.groups)),
    roles: JSON.stringify(strings(claims.realm_roles)), refreshedAt: Date.now(), refreshingUntil: 0};
}

export async function saveClaims(db, row) {
  await db.insertInto("oidcClaims").values(row)
    .onConflict((oc) => oc.columns(["providerId", "subject"]).doUpdateSet({userId: row.userId, groups: row.groups,
      roles: row.roles, refreshedAt: row.refreshedAt, refreshingUntil: 0}))
    .execute();
}

/**
 * At sign-in through a provider's callback, store the groups and realm roles from the ID token
 * Better Auth has just received from the token endpoint and checked against the provider's keys.
 * Refreshes are handled in session.js from the newly issued tokens; account updates anywhere else
 * write nothing (a refresh's merged account keeps the old ID token).
 */
async function storeClaimsAtSignIn(db, providerIds, account, ctx) {
  if (!account || !providerIds.has(account.providerId)) return;
  if (!(typeof ctx?.path === "string" && ctx.path.startsWith("/callback/"))) return;
  const claims = jwtPayload(account.idToken);
  if (!claims || claims.sub !== account.accountId) return;
  await saveClaims(db, claimsRow(account.providerId, account.accountId, account.userId, claims));
}

/** One Better Auth instance per request: Workers only expose bindings at request time. */
export function createAuth(env, config) {
  const db = new Kysely({dialect: new D1Dialect({database: env.DB})});
  // Keycloak is optional: providers whose client secret isn't set are left out (and logged), and
  // with none the gate is email sign-in only.
  const providers = config.auth.oidc.filter((p) => {
    if (env[p.secretName]) return true;
    console.error(`[gate auth] ${p.id}: no ${p.secretName} secret; sign-in with ${p.name} is off`);
    return false;
  });
  const providerIds = new Set(providers.map((p) => p.id));
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
    // Access rules count only verified addresses (an allowed domain, an admin's email), so
    // every sign-up gets a link to prove the address; a magic-link sign-in proves it too.
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({user, url}) => {
        try {
          await sendMail(env, config, {to: user.email, subject: `Confirm your email for ${config.brand.title}`,
            text: `Click to confirm your address:\n\n${url}\n\nIf you didn't sign up, ignore this email.`});
        } catch (err) {
          if (!(err instanceof MailError)) throw err;
        }
      }
    },
    session: {
      expiresIn: config.auth.sessionDays * 24 * 60 * 60, updateAge: 24 * 60 * 60,
      // How the session was signed in: "email" or an OIDC provider id (see session.create below).
      additionalFields: {
        provider: {type: "string", required: false, input: false},
        subject: {type: "string", required: false, input: false}
      }
    },
    // An OIDC sign-in with an address that already has an account joins that account only if
    // the provider says the address is verified (Better Auth's default for untrusted providers).
    account: {accountLinking: {enabled: true, trustedProviders: []}},
    rateLimit: {enabled: true, storage: "database", window: 60, max: 60,
      customRules: {"/sign-in/email": {window: 60, max: 10}, "/sign-in/magic-link": {window: 60, max: 5}, "/sign-up/email": {window: 60, max: 5}}},
    user: {
      additionalFields: {
        status: {type: "string", required: false, defaultValue: "pending", input: false}
      }
    },
    databaseHooks: {
      session: {
        create: {
          // Stamp each session with how it was signed in. Only the OAuth callback for a configured
          // provider makes an OIDC session; every other way in (password, magic link, email
          // confirmation) is "email". An OIDC session is also bound to the provider account the
          // callback has just signed in: the user's account for that provider updated last, which
          // the callback writes right before it creates the session. If a user has two accounts
          // for one provider (a Keycloak user deleted and made again with the same address), each
          // session stays with its own subject and its own claims.
          before: async (session, ctx) => {
            const id = ctx?.params?.id;
            const oidc = typeof ctx?.path === "string" && ctx.path.startsWith("/callback/") && providerIds.has(id);
            if (!oidc) return {data: {...session, provider: "email", subject: null}};
            const account = await db.selectFrom("account").select("accountId")
              .where("userId", "=", session.userId).where("providerId", "=", id)
              .orderBy("updatedAt", "desc").limit(1).executeTakeFirst();
            if (!account) return false;
            return {data: {...session, provider: id, subject: account.accountId}};
          }
        }
      },
      account: {
        create: {after: (account, ctx) => storeClaimsAtSignIn(db, providerIds, account, ctx)},
        update: {after: (account, ctx) => storeClaimsAtSignIn(db, providerIds, account, ctx)}
      },
      user: {
        create: {
          // Everyone starts as a pending user. doorman made the first account an active admin;
          // the gate doesn't: admins come from auth.admins (or the admin page), and a verified
          // address in an allowed domain is active without approval (access.js, statusOf).
          before: async (user) => ({data: {...user, role: "user", status: "pending"}}),
          after: async (user) => {
            const domain = String(user.email).toLowerCase().split("@")[1] ?? "";
            const approvesItself = config.auth.allowedDomains.includes(domain)
              || config.auth.admins.some((c) => c.email === String(user.email).toLowerCase() || c.emailDomain === domain);
            if (!approvesItself && config.mail.adminNotify) {
              try {
                await sendMail(env, config, {to: config.mail.adminNotify, subject: `${config.brand.title}: new account waiting for approval`,
                  text: `${user.email} signed up and is waiting for approval.\n\n${env.BASE_URL}/_obs/admin`});
              } catch (err) {
                if (!(err instanceof MailError)) throw err;
              }
            }
          }
        }
      }
    },
    plugins: [
      admin({defaultRole: "user", adminRoles: ["admin"]}),
      ...(providers.length ? [genericOAuth({config: providers.map((p) => ({
        providerId: p.id,
        discoveryUrl: `${p.issuer}/.well-known/openid-configuration`,
        clientId: p.clientId,
        clientSecret: env[p.secretName],
        scopes: ["openid", "email", "profile"],
        pkce: true,
        // Sign-out is local to the gate. Better Auth's provider logout would hand the browser a
        // logout URL carrying the ID token (id_token_hint).
        disableProviderLogout: true
      }))})] : []),
      magicLink({
        disableSignUp: true,
        sendMagicLink: async ({email, url}) => {
          try {
            await sendMail(env, config, {to: email, subject: `Sign in to ${config.brand.title}`, text: `Click to sign in:\n\n${url}\n\nThis link expires in 5 minutes.`});
          } catch (err) {
            console.error("[gate auth] magic link send failed", err);
            throw err;
          }
        }
      })
    ]
  });
  return Object.assign(auth, {db});
}

const FORWARDED_HEADERS = [
  "cookie", "origin", "referer", "user-agent", "accept-language", "cf-connecting-ip",
  "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user"
];

/**
 * Call one of Better Auth's own endpoints through `auth.handler`, the way a browser would.
 * Server-side `auth.api.*` calls skip the router, and with it the rate limiter and the
 * origin checks — the gate's HTML forms go through here instead so a form post is limited
 * exactly like a JSON post to the same endpoint. Headers the router cares about (client
 * IP for the limiter, origin/fetch-metadata for CSRF, cookie for the session) are carried
 * over from the incoming request; the URL is built on BASE_URL so it stays a trusted origin.
 */
export function callAuth(auth, env, request, path, body) {
  const headers = new Headers({"content-type": "application/json"});
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return auth.handler(new Request(new URL(path, env.BASE_URL), {method: "POST", headers, body: JSON.stringify(body)}));
}

/** The `message` from a Better Auth JSON error body, or null. */
export async function authErrorMessage(res) {
  try {
    const body = await res.json();
    return typeof body?.message === "string" && body.message ? body.message : null;
  } catch {
    return null;
  }
}
