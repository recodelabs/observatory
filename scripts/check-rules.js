// Advisory: list public pages and warn if none of the data files are public.
import {readdirSync, statSync} from "node:fs";
import {join, relative} from "node:path";
import {compileRules} from "../src/rules.js";
import config from "../doorman.config.js";

const dist = config.site.dist;
if (!dist) { console.log("check-rules: site.dist not set, skipping"); process.exit(0); }
const resolve = compileRules(config.pages ?? []);
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(relative(dist, p)); } })(dist);
const publicPages = files.filter((f) => f.endsWith(".html") && resolve(f) === "public");
const publicData = files.filter((f) => f.startsWith("_file/") && resolve(f) === "public");
const disabled = files.filter((f) => f.endsWith(".html") && resolve(f) === "disabled");
console.log(`public pages: ${publicPages.length ? publicPages.join(", ") : "none"}`);
console.log(`disabled pages: ${disabled.length ? disabled.join(", ") : "none"}`);
if (publicPages.length && !publicData.length) console.warn("warning: public pages exist but no _file/ data is public; their charts will get 401 for anonymous visitors");
