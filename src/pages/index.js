import {Hono} from "hono";
import {login} from "./login.js";
import {signup} from "./signup.js";
import {pending} from "./pending.js";
import {admin} from "./admin.js";

export const doorPages = new Hono();
doorPages.route("/", login);
doorPages.route("/", signup);
doorPages.route("/", pending);
doorPages.route("/", admin);
doorPages.all("*", (c) => c.text("Not found", 404));
