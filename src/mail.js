export async function sendMail(env, config, {to, subject, text}) {
  if (!env.RESEND_API_KEY) {
    console.log(`[doorman mail] to=${to} subject=${JSON.stringify(subject)}\n${text}`);
    return;
  }
  throw new Error("Resend sender not implemented yet");
}
