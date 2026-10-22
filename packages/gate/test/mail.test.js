import {describe, it, expect, vi} from "vitest";
import {sendMail, MailError} from "../src/mail.js";

const config = {mail: {from: "doorman@example.org"}, brand: {title: "T"}};

describe("sendMail", () => {
  it("logs to console without an API key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await sendMail({}, config, {to: "a@b", subject: "S", text: "hello"});
    expect(log.mock.calls[0][0]).toContain("hello");
    log.mockRestore();
  });
  it("posts to Resend with the key", async () => {
    const calls = [];
    const fetch = async (url, init) => { calls.push({url, init}); return new Response("{}", {status: 200}); };
    await sendMail({RESEND_API_KEY: "re_x"}, config, {to: "a@b", subject: "S", text: "hi"}, {fetch});
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].init.headers.authorization).toBe("Bearer re_x");
    expect(JSON.parse(calls[0].init.body)).toEqual({from: "doorman@example.org", to: ["a@b"], subject: "S", text: "hi"});
  });
  it("throws MailError on non-2xx", async () => {
    const fetch = async () => new Response("nope", {status: 422});
    await expect(sendMail({RESEND_API_KEY: "re_x"}, config, {to: "a@b", subject: "S", text: "hi"}, {fetch})).rejects.toBeInstanceOf(MailError);
  });
  it("throws MailError when fetch itself throws", async () => {
    const fetch = async () => { throw new TypeError("network down"); };
    await expect(sendMail({RESEND_API_KEY: "re_x"}, config, {to: "a@b", subject: "S", text: "hi"}, {fetch})).rejects.toBeInstanceOf(MailError);
  });
});
