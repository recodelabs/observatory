export const PREFIX = "_site/campaignhq/";
export async function putSite(env, files) {
  for (const [key, body] of Object.entries(files)) await env.SITE.put(PREFIX + key, body);
}
