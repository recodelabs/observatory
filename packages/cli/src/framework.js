// Observable Framework, as each site uses it: where it is installed, the site's source root,
// and its build and preview commands.
import {existsSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {pathToFileURL} from "node:url";

const CONFIG_NAMES = ["observablehq.config.js", "observablehq.config.ts", "observablehq.config.mjs"];

/** The site's Framework config file, or null. */
export function siteConfigFile(dir) {
  return CONFIG_NAMES.map((n) => join(dir, n)).find(existsSync) ?? null;
}

/** The site's Framework config (its default export). */
export async function siteConfig(dir) {
  const file = siteConfigFile(dir);
  if (!file) throw new Error(`${dir}: no observablehq.config.js`);
  return (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)).default ?? {};
}

/** The site's source root (Framework's `root`, default src). */
export async function siteRoot(dir) {
  return resolve(dir, (await siteConfig(dir)).root ?? "src");
}

/** The Framework installed for a site: the nearest node_modules/@observablehq/framework above it. */
export function framework(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const pkg = join(d, "node_modules", "@observablehq", "framework", "package.json");
    if (existsSync(pkg)) {
      const {version} = JSON.parse(readFileSync(pkg, "utf8"));
      const fw = dirname(pkg);
      return {dir: fw, version, bin: join(fw, "dist", "bin", "observable.js")};
    }
    if (dirname(d) === d) throw new Error(`${dir}: @observablehq/framework is not installed (npm install it in the project)`);
  }
}
