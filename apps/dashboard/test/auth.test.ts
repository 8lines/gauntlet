import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { api } from "../src/api.ts";
import { configureAuthTransport, localTokenStore, memoryTokenStore, onUnauthenticated } from "../src/auth.ts";
import { loginProblemMessage } from "../src/copy.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  configureAuthTransport(memoryTokenStore());
});

const unauthenticated = () => Response.json(
  { type: "urn:gauntlet:problem:unauthenticated", title: "Authentication required", status: 401 },
  { status: 401 },
);

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

test("a stored token is sent as a bearer credential", async () => {
  const store = memoryTokenStore();
  store.write("g1.s.token.signature");
  configureAuthTransport(store);
  let authorization: string | null = null;
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization");
    return Response.json({ targets: [] });
  };
  await api.targets();
  assert.equal(authorization, "Bearer g1.s.token.signature");
});

test("without a token no authorization header is sent", async () => {
  let headers: Headers | undefined;
  globalThis.fetch = async (_input, init) => {
    headers = new Headers(init?.headers);
    return Response.json({ targets: [] });
  };
  await api.targets();
  assert.equal(headers?.has("authorization"), false);
});

test("an unauthenticated answer clears the token and tells the app", async () => {
  const store = localTokenStore(memoryStorage());
  store.write("g1.s.stale.signature");
  configureAuthTransport(store);
  let notified = 0;
  const unsubscribe = onUnauthenticated(() => { notified += 1; });
  globalThis.fetch = async () => unauthenticated();
  const result = await api.targets();
  unsubscribe();
  assert.equal(result.ok, false);
  assert.equal(notified, 1);
  assert.equal(store.read(), undefined);
});

test("a failed login does not count as a lost session", async () => {
  let notified = 0;
  const unsubscribe = onUnauthenticated(() => { notified += 1; });
  globalThis.fetch = async () => Response.json(
    { type: "urn:gauntlet:problem:invalid-credentials", title: "Invalid credentials", status: 401 },
    { status: 401 },
  );
  const result = await api.login({ password: "nope", surface: "dashboard" });
  unsubscribe();
  assert.equal(result.ok, false);
  assert.equal(notified, 0);
});

test("the session probe can skip the stored token", async () => {
  const store = memoryTokenStore();
  store.write("g1.s.token.signature");
  configureAuthTransport(store);
  const seen: (string | null)[] = [];
  globalThis.fetch = async (_input, init) => {
    seen.push(new Headers(init?.headers).get("authorization"));
    return Response.json({ mode: "password", loginFields: ["password"], principal: null, expiresAt: null });
  };
  await api.session();
  await api.session({ cookieOnly: true });
  assert.deepEqual(seen, ["Bearer g1.s.token.signature", null]);
});

test("the local token store survives a new store on the same storage", () => {
  const storage = memoryStorage();
  localTokenStore(storage).write("g1.s.a.b");
  assert.equal(localTokenStore(storage).read(), "g1.s.a.b");
  localTokenStore(storage).clear();
  assert.equal(localTokenStore(storage).read(), undefined);
  const broken = { ...storage, getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } as Storage;
  assert.equal(localTokenStore(broken).read(), undefined);
  assert.doesNotThrow(() => localTokenStore(broken).write("x"));
});

test("login problems read in the user's terms", () => {
  const problem = (type: string, status: number) => ({ type: `urn:gauntlet:problem:${type}`, title: "x", status } as const);
  assert.equal(loginProblemMessage(problem("invalid-credentials", 401), ["password"]), "Incorrect password.");
  assert.equal(loginProblemMessage(problem("invalid-credentials", 401), ["username", "password"]), "Incorrect username or password.");
  assert.equal(loginProblemMessage(problem("rate-limited", 429), ["password"]), "Too many attempts. Try again in a few minutes.");
  assert.equal(loginProblemMessage(problem("network-unreachable", 0), ["password"]), "Could not connect to Gauntlet. Check your connection to the network Gauntlet runs in.");
});
