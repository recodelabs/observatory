// Sign-in with an OIDC provider (Keycloak), end to end through the Worker, against a fake
// provider: discovery, keys, and a token endpoint that signs ID tokens with a test key.
import {env} from "cloudflare:workers";
import {afterAll, beforeAll, describe, it, expect} from "vitest";
import {createApp} from "../src/index.js";
import {putSite, PREFIX} from "./helpers.js";

const ISSUER = "https://kc.test/realms/r";
const CONFIG = {
  cloudflare: {sites: PREFIX},
  sites: [
    {name: "main", path: "/", access: "signed-in"},
    {name: "ug", path: "/ug/", access: [{oidc: "kc", group: "/dashboards"}]}
  ],
  auth: {oidc: [{id: "kc", name: "Test Keycloak", issuer: ISSUER}], claimsMaxAge: 900, oidcSessionHours: 12}
};
const app = createApp(CONFIG);
const ENV = {...env, OIDC_KC_SECRET: "client-secret"};
const call = (path, init = {}) => app.fetch(new Request("http://example.com" + path, init), ENV);
const NAV = {accept: "text/html"};

// The fake provider's state: who signs in next, and how the token endpoint answers.
const provider = {sub: "kc-user-1", email: "kc@partner.example", groups: ["/dashboards"], refresh: "ok", nonce: null, calls: [],
  refreshIdToken: true};
let key, jwk;
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
async function idToken(extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = {alg: "RS256", typ: "JWT", kid: "test"};
  const payload = {iss: ISSUER, aud: "observatory", sub: provider.sub, email: provider.email, email_verified: true,
    name: "KC User", groups: provider.groups, realm_roles: ["viewer"], iat: now, exp: now + 300,
    ...(provider.nonce ? {nonce: provider.nonce} : {}), ...extra};
  const input = `${enc(header)}.${enc(payload)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(sig)}`;
}

const realFetch = globalThis.fetch;
beforeAll(async () => {
  key = await crypto.subtle.generateKey({name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256"}, true, ["sign", "verify"]);
  jwk = {...(await crypto.subtle.exportKey("jwk", key.publicKey)), kid: "test", alg: "RS256", use: "sig"};
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (!url.href.startsWith(ISSUER)) return realFetch(input, init);
    const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json"}});
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      return json({issuer: ISSUER, authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`, jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
        userinfo_endpoint: `${ISSUER}/protocol/openid-connect/userinfo`});
    }
    if (url.pathname.endsWith("/certs")) return json({keys: [jwk]});
    if (url.pathname.endsWith("/token")) {
      const body = new URLSearchParams(typeof init?.body === "string" ? init.body : await new Response(init?.body).text());
      provider.calls.push(body.get("grant_type"));
      if (body.get("grant_type") === "refresh_token" && provider.refresh !== "ok") return json({error: "invalid_grant"}, 400);
      // Like Keycloak: the access token is a JWT that carries the groups too.
      const refreshing = body.get("grant_type") === "refresh_token";
      return json({access_token: await idToken({nonce: undefined, aud: "account", jti: String(Math.random())}),
        refresh_token: "rt-" + Math.random(), token_type: "Bearer", expires_in: 300,
        ...(refreshing && !provider.refreshIdToken ? {} : {id_token: await idToken(refreshing ? {nonce: undefined} : {})})});
    }
    return json({error: "not found"}, 404);
  };
  await putSite(env, {"index.html": "home", "ug/index.html": "uganda"});
});
afterAll(() => { globalThis.fetch = realFetch; });

/** Sign in through the provider like a browser; returns the session cookie. */
let ip = 0;
async function signInWithProvider(next = "/ug/") {
  // A fresh client address each time: Better Auth limits sign-in starts per address.
  const start = await call("/_obs/oidc/kc", {method: "POST", headers: {"content-type": "application/x-www-form-urlencoded", origin: "http://example.com", "cf-connecting-ip": `10.9.0.${++ip}`}, body: new URLSearchParams({next}).toString()});
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("location"));
  expect(authorize.href.startsWith(`${ISSUER}/protocol/openid-connect/auth`)).toBe(true);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  provider.nonce = authorize.searchParams.get("nonce");
  const cookies = start.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const back = await call(`/auth/callback/kc?code=the-code&state=${encodeURIComponent(authorize.searchParams.get("state"))}`, {headers: {cookie: cookies}});
  expect(back.status).toBe(302);
  expect(back.headers.get("location")).toBe(next);
  const session = back.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token="));
  expect(session).toBeTruthy();
  return session.split(";")[0];
}

const claimsRow = () => env.DB.prepare(`select * from "oidcClaims" where "providerId" = 'kc' and subject = ?`).bind(provider.sub).first();
const makeStale = () => env.DB.prepare(`update "oidcClaims" set "refreshedAt" = ?`).bind(Date.now() - 901e3).run();

describe("sign-in with an OIDC provider", () => {
  it("shows a button for the provider on the login page", async () => {
    const html = await (await call("/_obs/login", {headers: NAV})).text();
    expect(html).toContain("Sign in with Test Keycloak");
    expect(html).toContain('action="/_obs/oidc/kc"');
  });
  it("signs in, stores the groups for the provider account, and opens the group's site", async () => {
    const cookie = await signInWithProvider();
    const row = await claimsRow();
    expect(JSON.parse(row.groups)).toEqual(["/dashboards"]);
    expect(JSON.parse(row.roles)).toEqual(["viewer"]);
    const session = await env.DB.prepare(`select provider from session order by "createdAt" desc limit 1`).first();
    expect(session.provider).toBe("kc");
    expect((await call("/ug/", {headers: {...NAV, cookie}})).status).toBe(200);
    expect((await call("/", {headers: {...NAV, cookie}})).status).toBe(200); // active without approval
  });
  it("refreshes stale claims: a user taken out of the group loses the site", async () => {
    const cookie = await signInWithProvider();
    provider.groups = [];
    await env.DB.prepare(`update "oidcClaims" set "refreshedAt" = ? where subject = ?`).bind(Date.now() - 901e3, provider.sub).run();
    const res = await call("/ug/", {headers: {...NAV, cookie}});
    expect(provider.calls.at(-1)).toBe("refresh_token");
    expect(res.status).toBe(403);
    expect(JSON.parse((await claimsRow()).groups)).toEqual([]);
    provider.groups = ["/dashboards"];
  });
  it("ends the session when the refresh fails", async () => {
    const cookie = await signInWithProvider();
    provider.refresh = "fail";
    await env.DB.prepare(`update "oidcClaims" set "refreshedAt" = ? where subject = ?`).bind(Date.now() - 901e3, provider.sub).run();
    try {
      const res = await call("/ug/", {headers: {...NAV, cookie}});
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toMatch(/^\/_obs\/login/);
    } finally {
      provider.refresh = "ok";
    }
  });
  it("ends the session after oidcSessionHours, however recent the claims", async () => {
    const cookie = await signInWithProvider();
    const token = decodeURIComponent(cookie.split("=")[1]).split(".")[0];
    await env.DB.prepare(`update session set "createdAt" = ? where token = ?`).bind(new Date(Date.now() - 13 * 3600e3).toISOString(), token).run();
    const res = await call("/ug/", {headers: {...NAV, cookie}});
    expect(res.status).toBe(302);
    expect(await env.DB.prepare("select id from session where token = ?").bind(token).first()).toBeNull();
  });
  it("on refresh, reads the groups from the new access token, never the kept ID token", async () => {
    const cookie = await signInWithProvider();
    provider.refreshIdToken = false;
    provider.groups = [];
    await makeStale();
    try {
      expect((await call("/ug/", {headers: {...NAV, cookie}})).status).toBe(403);
    } finally {
      provider.refreshIdToken = true;
      provider.groups = ["/dashboards"];
    }
  });
  it("a failed refresh ends every session of that account", async () => {
    const first = await signInWithProvider();
    const second = await signInWithProvider();
    provider.refresh = "fail";
    await makeStale();
    try {
      expect((await call("/ug/", {headers: {...NAV, cookie: first}})).status).toBe(302);
      expect((await call("/ug/", {headers: {...NAV, cookie: second}})).status).toBe(302);
    } finally {
      provider.refresh = "ok";
    }
  });
  it("a Keycloak user made again with the same address doesn't get the old one's groups", async () => {
    const old = await signInWithProvider();
    provider.sub = "kc-user-2";
    provider.groups = [];
    try {
      const remade = await signInWithProvider();
      expect((await call("/ug/", {headers: {...NAV, cookie: remade}})).status).toBe(403);
      expect((await call("/ug/", {headers: {...NAV, cookie: old}})).status).toBe(200);
    } finally {
      provider.sub = "kc-user-1";
      provider.groups = ["/dashboards"];
    }
  });
  it("sign-out stays local and hands out no ID token", async () => {
    const cookie = await signInWithProvider();
    const res = await call("/auth/sign-out", {method: "POST", headers: {cookie, origin: "http://example.com", "content-type": "application/json"}, body: "{}"});
    expect(await res.text()).not.toMatch(/id_token_hint|eyJ/);
  });
  it("keeps the provider's tokens away from the browser", async () => {
    const cookie = await signInWithProvider();
    for (const path of ["/auth/get-access-token", "/auth/refresh-token", "/auth/account-info", "/auth/list-accounts", "/auth/link-social", "/auth/unlink-account"]) {
      const res = await call(path, {method: "POST", headers: {cookie, origin: "http://example.com", "content-type": "application/json"}, body: JSON.stringify({providerId: "kc"})});
      expect(res.status, path).toBe(404);
    }
  });
});

describe("without a provider secret", () => {
  it("leaves the provider out: no button, no sign-in", async () => {
    const plain = createApp(CONFIG);
    const html = await (await plain.fetch(new Request("http://example.com/_obs/login", {headers: NAV}), env)).text();
    expect(html).not.toContain("Sign in with");
    const res = await plain.fetch(new Request("http://example.com/_obs/oidc/kc", {method: "POST", headers: {origin: "http://example.com", "content-type": "application/x-www-form-urlencoded"}, body: "next=%2F"}), env);
    expect(res.status).toBe(404);
  });
});
