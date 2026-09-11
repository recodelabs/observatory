export class MailError extends Error {}

export async function sendMail(env, config, {to, subject, text}, {fetch: doFetch = globalThis.fetch} = {}) {
  if (!env.RESEND_API_KEY) {
    console.log(`[doorman mail] to=${to} subject=${JSON.stringify(subject)}\n${text}`);
    return;
  }
  const res = await doFetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json"},
    body: JSON.stringify({from: config.mail.from, to: [to], subject, text})
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[doorman mail] resend ${res.status}: ${detail}`);
    throw new MailError(`resend ${res.status}`);
  }
}
