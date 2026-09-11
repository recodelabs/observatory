import {Hono} from "hono";
import {login} from "./login.js";
import {signup} from "./signup.js";
import {pending} from "./pending.js";

export const doorPages = new Hono();
doorPages.route("/", login);
doorPages.route("/", signup);
doorPages.route("/", pending);
doorPages.all("*", (c) => c.text("Not found", 404));
