async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function csrfToken(secret, sessionToken) {
  return (await hmac(secret, "csrf:" + sessionToken)).slice(0, 32);
}
export async function checkCsrf(secret, sessionToken, submitted) {
  const expected = await csrfToken(secret, sessionToken);
  if (typeof submitted !== "string" || submitted.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ submitted.charCodeAt(i);
  return diff === 0;
}
