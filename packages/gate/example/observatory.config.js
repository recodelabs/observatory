// The config `wrangler dev` uses in this repo: two sites under one gate, one of them closed to
// a group. A deployment uses its project's own observatory.config.js (see packages/cli).
export default {
  host: "http://localhost:8787",
  brand: {title: "Example dashboards", accent: "#0b57d0", logo: null},
  cloudflare: {bucket: "site", sites: "_site/"},
  sites: [
    {name: "main", path: "/", access: "public"},
    {name: "team", path: "/team/", access: [{emailDomain: "example.org"}]}
  ],
  auth: {
    sessionDays: 30,
    admins: [{email: "admin@example.org"}],
    email: {allowedDomains: [], from: "observatory@localhost", adminNotify: null}
  },
  access: []
};
