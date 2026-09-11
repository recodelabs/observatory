import {Hono} from "hono";
export const doorPages = new Hono();
doorPages.all("*", (c) => c.text("Not found", 404));
