// doorman.config.js — per-deployment settings. Imported by the Worker; wrangler bundles it.
export default {
  site: {name: "campaignhq", dist: "../icr/campaignhq/dist"},
  brand: {title: "Campaign Dashboards", accent: "#0b57d0", logo: null},
  auth: {allowedDomains: [], sessionDays: 30},
  mail: {from: "doorman@healthcampaigns.org", adminNotify: null},
  pages: []
};
