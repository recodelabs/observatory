// doorman.config.js — one per deployment; imported by the Worker entry file (wrangler bundles it).
// This copy drives `wrangler dev` and the test suite in this repo. See README "Config reference".
export default {
  site: {name: "example", dist: "example/dist"},
  brand: {title: "Example site", accent: "#0b57d0", logo: null},
  auth: {allowedDomains: [], sessionDays: 30},
  mail: {from: "doorman@localhost", adminNotify: null},
  pages: [{match: "about", access: "public"}]
};
