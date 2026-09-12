export function isNavigation(request) {
  return (request.headers.get("accept") || "").includes("text/html");
}

/**
 * Pure decision for one request. `user` is null (no session) or {status, role}.
 * `path` has no leading slash; it is only used to build the login redirect.
 */
export function decide({access, user, isNavigation, path}) {
  if (access === "disabled") return {kind: "notfound"};
  if (access === "public") return {kind: "serve"};
  if (!user) {
    return isNavigation
      ? {kind: "redirect", to: `/_door/login?next=${encodeURIComponent("/" + path)}`}
      : {kind: "status", status: 401};
  }
  if (user.status !== "active") {
    return isNavigation ? {kind: "redirect", to: "/_door/pending"} : {kind: "status", status: 403};
  }
  return {kind: "serve"};
}
