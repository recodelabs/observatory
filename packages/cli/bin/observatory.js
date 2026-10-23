#!/usr/bin/env node
// observatory: build, preview and deploy Observable Framework sites from a warehouse in R2.
import {build, check, deploy, dev, newSite, pull} from "../src/commands.js";

const USAGE = `usage: observatory <command> [options]

  new <name> [--dir DIR]       create a site from the template (default sites/<name>)
  dev <site> [--local] [--pull] [--no-edit] [preview options…]
                               preview a site and edit its pages beside the preview;
                               data from the cached warehouse (--pull: refresh it
                               first; --local: the local copy; --no-edit: preview only)
  pull [<site>…]               copy the sites' warehouses from R2 into the cache
  build [<site>…] [--local]    pull, then build (all sites when none are named)
  deploy [<site>…] [--local] [--skip-build] [--dry-run] [--prune] [--no-worker]
                               build, upload each site to R2, deploy the host Worker
  check                        check the config and the sites; list who sees what

Run in the folder with observatory.config.js, or one below it.`;

const FLAGS = {
  new: {"--dir": "dir"},
  dev: {"--local": "local", "--pull": "pull", "--no-edit": "noEdit"},
  pull: {},
  build: {"--local": "local"},
  deploy: {"--local": "local", "--skip-build": "skipBuild", "--dry-run": "dryRun", "--prune": "prune", "--no-worker": "noWorker"},
  check: {}
};
const TAKES_VALUE = new Set(["--dir"]);

/** Split args into positionals and known flags; dev passes anything else to Framework's preview. */
function parse(command, args) {
  const known = FLAGS[command];
  const opts = {}, positionals = [], rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (known[a]) {
      if (TAKES_VALUE.has(a)) {
        if (i + 1 >= args.length) throw new Error(`${a} needs a value`);
        opts[known[a]] = args[++i];
      } else {
        opts[known[a]] = true;
      }
    } else if (a.startsWith("-")) {
      if (command !== "dev") throw new Error(`unknown option ${a} for ${command}`);
      rest.push(a);
    } else if (command === "dev" && positionals.length) {
      rest.push(a);   // a value of a preview option, e.g. --port 3000
    } else {
      positionals.push(a);
    }
  }
  if (opts.noWorker) opts.worker = false;
  return {opts, positionals: command === "dev" ? [...positionals, ...rest] : positionals};
}

const COMMANDS = {new: newSite, dev, pull, build, deploy, check};
const [command, ...args] = process.argv.slice(2);
if (!command || command === "-h" || command === "--help" || command === "help") {
  console.log(USAGE);
} else if (!COMMANDS[command]) {
  console.error(`unknown command ${command}\n\n${USAGE}`);
  process.exitCode = 2;
} else {
  try {
    const {opts, positionals} = parse(command, args);
    await COMMANDS[command](positionals, opts);
  } catch (e) {
    console.error(`observatory ${command}: ${e.message}`);
    process.exitCode = 1;
  }
}
