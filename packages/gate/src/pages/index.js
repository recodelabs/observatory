import {Hono} from "hono";
import {login} from "./login.js";
import {signup} from "./signup.js";
import {pending} from "./pending.js";
import {admin} from "./admin.js";

export const obsPages = new Hono();
obsPages.route("/", login);
obsPages.route("/", signup);
obsPages.route("/", pending);
obsPages.route("/", admin);
obsPages.all("*", (c) => c.text("Not found", 404));
