import { isProtocolId } from "@8lines/gauntlet-protocol";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createApiToken } from "./auth/api-tokens.js";
import { hashPassword } from "./auth/passwords.js";

const EX_USAGE = 64;

const USAGE = `Usage: node dist/auth-cli.js hash-password | create-token <name> | generate-secret

  hash-password     Read a password from stdin and print its hash for auth.password.
  create-token      Print a new API token once, and its entry for auth.tokens.
  generate-secret   Print a new value for GAUNTLET_AUTH_SECRET.
`;

export interface AuthCliIo {
  readonly readStdin: () => Promise<string>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export async function runAuthCli(argv: readonly string[], io: AuthCliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "hash-password" && rest.length === 0) {
    const password = (await io.readStdin()).replace(/\r?\n$/, "");
    if (password.length === 0) {
      io.stderr("The password is empty.\n");
      return EX_USAGE;
    }
    io.stdout(`${await hashPassword(password)}\n`);
    return 0;
  }
  if (command === "create-token" && rest.length === 1 && isProtocolId(rest[0])) {
    const { token, hash } = createApiToken();
    io.stdout(`token: ${token}\n\nAdd to auth.tokens:\n  - name: ${rest[0]}\n    hash: "${hash}"\n`);
    return 0;
  }
  if (command === "generate-secret" && rest.length === 0) {
    io.stdout(`${randomBytes(32).toString("base64url")}\n`);
    return 0;
  }
  io.stderr(USAGE);
  return EX_USAGE;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return await readHiddenLine();
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads one line from a terminal without echoing it. */
async function readHiddenLine(): Promise<string> {
  process.stderr.write("Password: ");
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  try {
    return await new Promise<string>((accept, reject) => {
      let line = "";
      const onData = (chunk: string) => {
        for (const character of chunk) {
          if (character === "\r" || character === "\n" || character === "\u0004") {
            process.stdin.off("data", onData);
            process.stderr.write("\n");
            accept(line);
            return;
          }
          if (character === "\u0003") {
            process.stdin.off("data", onData);
            reject(new Error("Interrupted"));
            return;
          }
          line = character === "\u007f" || character === "\b" ? line.slice(0, -1) : line + character;
        }
      };
      process.stdin.on("data", onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  try {
    process.exitCode = await runAuthCli(process.argv.slice(2), {
      readStdin,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
  } catch {
    process.stderr.write("\nGauntlet auth command failed\n");
    process.exitCode = 1;
  }
}
