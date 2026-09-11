import userConfig from "../doorman.config.js";

export function loadConfig(raw = userConfig) {
  if (!raw?.site?.name) throw new Error("doorman.config.js: site.name is required");
  return {
    site: {name: raw.site.name, dist: raw.site.dist ?? null},
    brand: {title: raw.brand?.title ?? raw.site.name, accent: raw.brand?.accent ?? "#0b57d0", logo: raw.brand?.logo ?? null},
    auth: {allowedDomains: (raw.auth?.allowedDomains ?? []).map((d) => d.toLowerCase()), sessionDays: raw.auth?.sessionDays ?? 30},
    mail: {from: raw.mail?.from ?? "doorman@localhost", adminNotify: raw.mail?.adminNotify ?? null},
    pages: raw.pages ?? []
  };
}
