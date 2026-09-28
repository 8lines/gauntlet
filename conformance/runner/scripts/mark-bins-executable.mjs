import { chmodSync } from "node:fs";

for (const filename of ["cli.js", "extended-cli.js", "fixture-adapter.js"]) {
  chmodSync(new URL(`../dist/${filename}`, import.meta.url), 0o755);
}
