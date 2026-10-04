import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryTokenStore, type AuthSession, type LoginResult } from "../src/auth.ts";
import type { Result } from "../src/api.ts";
import { completeWidgetLogin } from "../src/widget/usePanelAuth.ts";

const result: LoginResult = {
  principal: { kind: "shared", id: "shared", displayName: "Shared password" },
  token: "g1.s.widget.signature",
  expiresAt: "2026-10-04T12:00:00.000Z",
};
const base: AuthSession = { mode: "password", loginFields: ["password"], principal: null, expiresAt: null };
const answer = (session: AuthSession): Promise<Result<AuthSession>> => Promise.resolve({ ok: true, data: session });

test("when the cookie works the panel keeps no token", async () => {
  const store = memoryTokenStore();
  store.write("g1.s.old.signature");
  const session = await completeWidgetLogin(result, base, store, () => answer({ ...base, principal: result.principal, expiresAt: result.expiresAt }));
  assert.equal(store.read(), undefined);
  assert.equal(session.principal?.id, "shared");
});

test("when the cookie is refused the panel keeps the token", async () => {
  const store = memoryTokenStore();
  const session = await completeWidgetLogin(result, base, store, () => answer(base));
  assert.equal(store.read(), result.token);
  assert.deepEqual(session, { ...base, principal: result.principal, expiresAt: result.expiresAt });
});

test("when the probe fails the panel keeps the token", async () => {
  const store = memoryTokenStore();
  const failed = () => Promise.resolve({ ok: false, problem: { type: "urn:gauntlet:problem:network-unreachable", title: "x", status: 0 } } as const);
  const session = await completeWidgetLogin(result, base, store, failed);
  assert.equal(store.read(), result.token);
  assert.equal(session.principal?.id, "shared");
});
