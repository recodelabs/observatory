import {env, exports} from "cloudflare:workers";
import {it, expect} from "vitest";

it("worker answers and bindings exist", async () => {
  const res = await exports.default.fetch("http://example.com/");
  expect(res.status).toBe(200);
  const row = await env.DB.prepare("select count(*) as n from user").first();
  expect(row.n).toBe(0);
  await env.SITE.put("_site/campaignhq/probe.txt", "hi");
  expect(await (await env.SITE.get("_site/campaignhq/probe.txt")).text()).toBe("hi");
});
