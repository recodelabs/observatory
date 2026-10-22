// Running other programs: Framework, rclone, wrangler, gh.
import {spawn, spawnSync} from "node:child_process";

/** Run a command to completion with the terminal attached; throws if it fails. */
export function run(cmd, args, {cwd, env, quiet = false} = {}) {
  const r = spawnSync(cmd, args, {cwd, env: env ?? process.env, stdio: quiet ? ["ignore", "ignore", "inherit"] : "inherit"});
  if (r.error) throw new Error(r.error.code === "ENOENT" ? `${cmd} is not installed (or not on PATH)` : r.error.message);
  if (r.status !== 0) throw new Error(`${cmd} ${args[0] ?? ""} failed (exit ${r.status ?? r.signal})`);
}

/** Run a command and return its standard output; throws if it fails. */
export function output(cmd, args, {cwd, env} = {}) {
  const r = spawnSync(cmd, args, {cwd, env: env ?? process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
  if (r.error) throw new Error(r.error.code === "ENOENT" ? `${cmd} is not installed (or not on PATH)` : r.error.message);
  // Some tools (wrangler --json) report errors on stdout, so both go in the message.
  if (r.status !== 0) throw new Error(`${cmd} ${args[0] ?? ""} failed (exit ${r.status}): ${[r.stderr, r.stdout].map((x) => x.trim()).filter(Boolean).join("\n")}`);
  return r.stdout;
}

/** Run a long-lived command (a preview server) and resolve with its exit code. */
export function serve(cmd, args, {cwd, env} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {cwd, env, stdio: "inherit"});
    const stop = () => child.kill("SIGINT");
    process.on("SIGINT", stop);
    child.on("error", reject);
    child.on("exit", (code) => { process.off("SIGINT", stop); resolve(code ?? 0); });
  });
}
