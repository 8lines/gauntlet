import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const distribution = fileURLToPath(new URL("../", import.meta.url));
const readme = new URL("../README.md", import.meta.url);
const MAX_README_BYTES = 256 * 1024;
const REQUIRED_HEADINGS = [
  "## Safety boundary",
  "## Prerequisites",
  "## First installation",
  "## Integrating another Compose application",
  "## Private access",
  "## Editing targets and environment",
  "## Status, readiness, and logs",
  "## Upgrade",
  "## Rollback",
  "## Stop, start, and removal",
  "## Backup and recovery limits",
  "## Remote Docker and VPS limitations",
  "## Troubleshooting",
];

async function readBoundedUtf8() {
  const bytes = await readFile(readme);
  assert.ok(bytes.length > 0 && bytes.length <= MAX_README_BYTES);
  assert.equal(bytes.includes(0x0d), false, "README must use LF line endings");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function namedFences(markdown) {
  const lines = markdown.split("\n");
  const blocks = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const marker = /^<!-- gauntlet:([a-z0-9-]+) -->$/.exec(lines[index]);
    if (marker === null) continue;
    assert.equal(blocks.has(marker[1]), false, `duplicate fence marker ${marker[1]}`);
    const opening = lines[index + 1] ?? "";
    const language = /^```([a-z]+)$/.exec(opening);
    assert.notEqual(language, null, `marker ${marker[1]} must be followed by a fenced block`);
    const body = [];
    let cursor = index + 2;
    for (; cursor < lines.length && lines[cursor] !== "```"; cursor += 1) body.push(lines[cursor]);
    assert.ok(cursor < lines.length, `fence ${marker[1]} must close`);
    assert.ok(body.length <= 80, `fence ${marker[1]} is unexpectedly large`);
    blocks.set(marker[1], { language: language[1], text: `${body.join("\n")}\n` });
    index = cursor;
  }
  return blocks;
}

function assertEveryFenceIsNamedAndClosed(markdown, expectedCount) {
  const lines = markdown.split("\n");
  let openCharacter;
  let openLength = 0;
  let count = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (openCharacter === undefined) {
      const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (opener === null) continue;
      assert.match(line, /^```(?:sh|yaml)$/, `unsupported or unclassified fence at line ${index + 1}`);
      assert.match(
        lines[index - 1] ?? "",
        /^<!-- gauntlet:[a-z0-9-]+ -->$/,
        `unmarked fence at line ${index + 1}`,
      );
      openCharacter = opener[1][0];
      openLength = opener[1].length;
      count += 1;
    } else {
      const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closer === null || closer[1][0] !== openCharacter || closer[1].length < openLength) continue;
      assert.equal(line, "```", `malformed closing fence at line ${index + 1}`);
      openCharacter = undefined;
      openLength = 0;
    }
  }
  assert.equal(openCharacter, undefined, "all fences must close");
  assert.equal(count, expectedCount, "every fence must be classified exactly once");
}

function assertNoUnsafeInstructions(markdown) {
  assert.doesNotMatch(markdown, /docker\s+compose/, "direct Compose commands must never bypass the wrapper");
  assert.doesNotMatch(markdown, /(?:^|\s)(?:-p|--password(?:-stdin)?|-u|--username)(?:=|\s)/m, "credential arguments are forbidden");
  assert.doesNotMatch(markdown, /(?:TOKEN|PASSWORD|SECRET|PRIVATE_KEY)\s*=\s*["']?\S/i, "credential assignments are forbidden");
  assert.doesNotMatch(markdown, /GAUNTLET_BIND\s*=\s*["']?(?:0\.0\.0\.0|\[?::\]?|\*)/i, "public dashboard binding is forbidden");
  assert.doesNotMatch(markdown, /host_ip\s*:\s*["']?(?:0\.0\.0\.0|\[?::\]?|\*)/i, "public Compose host_ip is forbidden");

  const blocks = namedFences(markdown);
  assertEveryFenceIsNamedAndClosed(markdown, blocks.size);
  for (const [name, block] of blocks) {
    for (const forbiddenCommand of [
      /\bdocker\s+compose\b/,
      /(?:^|\s)(?:-p|--password(?:-stdin)?|-u|--username)(?:=|\s)/,
      /(?:^|\s)(?:password|secret|token)=\S/i,
      /(?:^|\s)GAUNTLET_BIND\s*=\s*["']?(?:0\.0\.0\.0|\[?::\]?|\*)["']?(?:\s|$)/,
      /(?:^|\s)host_ip\s*:\s*["']?(?:0\.0\.0\.0|\[?::\]?|\*)/,
      /(?:^|\s)(?:--publish|-p)\s+(?:0\.0\.0\.0:)?\d+:/,
    ]) assert.doesNotMatch(block.text, forbiddenCommand, `${name}: unsafe command`);
  }
}

test("runbook has the complete non-production operating contract", async () => {
  const markdown = await readBoundedUtf8();
  let lastHeading = -1;
  for (const heading of REQUIRED_HEADINGS) {
    const position = markdown.indexOf(`${heading}\n`);
    assert.ok(position > lastHeading, heading);
    lastHeading = position;
  }

  for (const required of [
    "v0.1 has no authentication",
    "one replica",
    "process-local",
    "127.0.0.1",
    "Tailscale",
    "SSH tunnel",
    "firewall",
    "same Docker Engine",
    "one Gauntlet instance per Docker Engine",
    "A separate directory does not isolate",
    "globally unique",
    "short downtime",
    "does not delete `.env` or `config.yaml`",
    "does not remove the external `gauntlet` network",
    "disabled independently in production",
    "binding is not authentication",
    "daemon host",
  ]) assert.ok(markdown.includes(required), required);

  for (const forbidden of [
    "ALLOW_PRODUCTION",
    "--reuse-values",
    "docker system prune",
    "docker network rm gauntlet",
    "0.0.0.0:",
    "Tailscale Funnel",
    "container_name:",
    "network_mode: host",
    "GAUNTLET_IMAGE=ghcr.io/8lines/gauntlet:latest",
  ]) assert.equal(markdown.includes(forbidden), false, forbidden);

  assertNoUnsafeInstructions(markdown);
});

test("runbook safety policy rejects representative command and fence bypasses", async () => {
  const markdown = await readBoundedUtf8();
  const attacks = [
    "\n<!-- gauntlet:attack -->\n```sh\nsudo docker compose up\n```\n",
    "\n<!-- gauntlet:attack -->\n```sh\ndocker login -u bot -p secret ghcr.io\n```\n",
    "\n<!-- gauntlet:attack -->\n```sh\nGAUNTLET_BIND=\"0.0.0.0\" ./gauntlet up\n```\n",
    "\n<!-- gauntlet:attack -->\n```yaml\nhost_ip: 0.0.0.0\n```\n",
    "\n```bash\n./gauntlet up\n```\n",
    "\n~~~yaml\nservices:\n  adapter:\n    ports: [\"8081:8081\"]\n~~~\n",
    "\n  ```sh\n./gauntlet up --publish 8080:8080\n  ```\n",
  ];
  for (const attack of attacks) {
    assert.throws(() => assertNoUnsafeInstructions(`${markdown}${attack}`));
  }
});

test("runbook exposes exact bounded lifecycle and application fragments", async () => {
  const markdown = await readBoundedUtf8();
  const blocks = namedFences(markdown);
  assert.deepEqual([...blocks.keys()].sort(), [
    "application-network",
    "config-reload",
    "first-install",
    "recreate",
    "rollback",
    "routine",
    "shutdown",
    "upgrade",
  ]);
  assert.deepEqual(blocks.get("first-install"), {
    language: "sh",
    text: "./gauntlet init\n# Edit .env and config.yaml, then review the declared non-production environment.\n./gauntlet up -d --wait\n./gauntlet ps\n",
  });
  assert.equal(blocks.get("config-reload")?.text, "./gauntlet restart\n");
  assert.equal(blocks.get("recreate")?.text, "./gauntlet up -d --wait\n");
  assert.equal(blocks.get("routine")?.text, "./gauntlet ps\n./gauntlet logs --tail 200\n./gauntlet logs -f\n");
  assert.equal(blocks.get("upgrade")?.text, "./gauntlet pull\n./gauntlet up -d --wait\n./gauntlet ps\n");
  assert.equal(blocks.get("rollback")?.text, "./gauntlet pull\n./gauntlet up -d --wait\n./gauntlet ps\n");
  assert.equal(blocks.get("shutdown")?.text, "./gauntlet stop\n./gauntlet start\n./gauntlet down\n");
  assert.deepEqual(blocks.get("application-network"), {
    language: "yaml",
    text: "services:\n  billing:\n    expose:\n      - \"8080\"\n    networks:\n      default: {}\n      gauntlet:\n        aliases:\n          - small-apps-dev-billing\n\nnetworks:\n  gauntlet:\n    external: true\n    name: gauntlet\n",
  });

  const applicationBlock = blocks.get("application-network")?.text ?? "";
  for (const forbidden of ["ports:", "container_name:", "network_mode:", "host.docker.internal"] ) {
    assert.equal(applicationBlock.includes(forbidden), false, forbidden);
  }
  assert.equal(
    [...blocks.values()].some(({ text }) => /(?:^|\n)docker compose(?:\s|$)/.test(text)),
    false,
    "operators must use the pinned wrapper rather than bypassing it",
  );
  const config = await readFile(new URL("../config.example.yaml", import.meta.url), "utf8");
  for (const alias of ["small-apps-dev-billing", "small-apps-dev-portal"]) {
    assert.ok(config.includes(`http://${alias}:8080`), alias);
    assert.ok(markdown.includes(alias), alias);
  }
});

test("every documented wrapper command is executable only through fake Docker", async () => {
  const markdown = await readBoundedUtf8();
  const blocks = namedFences(markdown);
  const root = await realpath(await mkdtemp(join(tmpdir(), "gauntlet-runbook-")));
  const copy = join(root, "distribution");
  const bin = join(root, "bin");
  const receipt = join(root, "receipt");
  await Promise.all([mkdir(copy), mkdir(bin)]);
  try {
    for (const file of ["gauntlet", "compose.yaml", ".env.example", "config.example.yaml"]) {
      await copyFile(join(distribution, file), join(copy, file));
    }
    await chmod(join(copy, "gauntlet"), 0o755);
    await writeFile(join(bin, "docker"), `#!/bin/sh\nset -eu\nprintf '%s\\0' "$@" >> "$RUNBOOK_RECEIPT"\nprintf '\\n' >> "$RUNBOOK_RECEIPT"\nexit 0\n`, { mode: 0o700 });
    await writeFile(receipt, "");
    const environment = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: root,
      RUNBOOK_RECEIPT: receipt,
    };

    const commands = [];
    for (const block of blocks.values()) {
      if (block.language !== "sh") continue;
      for (const line of block.text.split("\n")) {
        if (line.startsWith("./gauntlet ")) commands.push(line.slice("./gauntlet ".length).split(" "));
      }
    }
    assert.ok(commands.length >= 10);
    for (const args of commands) {
      const result = spawnSync(join(copy, "gauntlet"), args, {
        cwd: copy,
        env: environment,
        encoding: "utf8",
        maxBuffer: 256 * 1024,
        stdio: "pipe",
      });
      assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    }

    const recorded = await readFile(receipt, "utf8");
    assert.equal(recorded.includes("login"), false);
    assert.equal(recorded.includes("network\0rm"), false);
    assert.equal(recorded.includes("compose\0--project-name\0gauntlet"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
