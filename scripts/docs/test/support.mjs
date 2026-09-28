import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), "gauntlet-docs-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const destination = resolve(root, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents, "utf8");
  }
  return await realpath(root);
}

export function read(relativePath) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}
