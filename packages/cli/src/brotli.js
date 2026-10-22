// Brotli copies of the build's .wasm files (name.wasm.br), which the host sends to browsers that
// accept brotli. Cloudflare compresses on the fly at a lower level: the DuckDB engine goes over
// the wire as 7.0 MB that way, 4.7 MB from the quality-11 copy. Copies are cached by checksum,
// so an unchanged file is compressed once (it takes about a minute).
import {createHash} from "node:crypto";
import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {join, relative} from "node:path";
import {promisify} from "node:util";
import {brotliCompress, constants} from "node:zlib";
import {cacheDir} from "./r2.js";

const compress = promisify(brotliCompress);

function* walk(dir) {
  for (const e of readdirSync(dir, {withFileTypes: true})) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

export async function precompress(dist) {
  const cache = join(cacheDir(), "br");
  mkdirSync(cache, {recursive: true});
  const files = [...walk(dist)];
  for (const f of files) if (f.endsWith(".wasm.br")) rmSync(f);
  for (const f of files.filter((f) => f.endsWith(".wasm"))) {
    const data = readFileSync(f);
    const br = join(cache, `${createHash("sha256").update(data).digest("hex")}.br`);
    if (!existsSync(br)) {
      console.error(`== brotli ${relative(dist, f)}`);
      const out = await compress(data, {params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_LGWIN]: 24,
        [constants.BROTLI_PARAM_SIZE_HINT]: data.length
      }});
      writeFileSync(`${br}.tmp`, out);
      renameSync(`${br}.tmp`, br);
    }
    copyFileSync(br, `${f}.br`);
  }
}
