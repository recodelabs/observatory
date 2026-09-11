const ACCESS = new Set(["public", "protected", "disabled"]);
const RUNTIME_PREFIXES = ["_observablehq/", "_npm/", "_import/"];

/** Glob → RegExp. `*` matches within a segment, `**` across segments. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; }
      else re += "[^/]*";
    } else if (".+?^${}()|[]\\".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  return new RegExp(`^${re}$`);
}

/** Strip Framework cleanUrl suffixes so `about`, `about.html`, `about/index.html` all test as `about`. */
function pageKey(path) {
  if (path.endsWith("/index.html")) return path.slice(0, -"/index.html".length);
  if (path === "index.html") return "";
  if (path.endsWith(".html")) return path.slice(0, -".html".length);
  return path;
}

export function compileRules(pages = []) {
  const compiled = pages.map(({match, access}) => {
    if (!ACCESS.has(access)) throw new Error(`rule ${JSON.stringify(match)}: access must be public, protected or disabled, got ${JSON.stringify(access)}`);
    return {re: globToRegExp(match), access};
  });
  const anyPublic = compiled.some((r) => r.access === "public");
  return function resolveAccess(path) {
    const key = pageKey(path);
    for (const {re, access} of compiled) if (re.test(path) || re.test(key)) return access;
    if (anyPublic && RUNTIME_PREFIXES.some((p) => path.startsWith(p))) return "public";
    return "protected";
  };
}
