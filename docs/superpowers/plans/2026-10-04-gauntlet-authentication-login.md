# Gauntlet Authentication: Password Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operators can put the Gauntlet dashboard, REST API, widget panel and MCP endpoint behind a password (shared or per user) and static API tokens.

**Architecture:** A self-contained `apps/server/src/auth/` module (stateless HMAC tokens, scrypt passwords, one Fastify `onRequest` guard, `/api/v1/auth/*` routes) configured from a new `auth` YAML section and `GAUNTLET_AUTH_SECRET`. The dashboard gates its shell on `GET /api/v1/auth/session` and reacts to `401` from its single `request()` wrapper. The widget panel logs in inside the iframe and uses a partitioned cookie or, when that fails, a bearer token in its own `localStorage`.

**Tech Stack:** Node 24, Fastify 5, `node:crypto` (HMAC-SHA256, HKDF, scrypt, `randomBytes`, `timingSafeEqual`), `node:async_hooks` `AsyncLocalStorage`, React 19, shadcn/ui, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-03-gauntlet-authentication-design.md`

**Scope:** spec phases 1-3 and their documentation. MCP OAuth (spec phase 4: metadata, registration, authorize, token, consent screen) gets its own plan. Until then, with authentication enabled `/mcp` accepts sessions and static API tokens, and its `401` carries no `resource_metadata` challenge.

## Global Constraints

- No new runtime dependencies in `apps/server` or `apps/dashboard`.
- Code, identifiers, comments, file names and UI copy in English. Product name is Gauntlet.
- UI follows the design rules in `docs/superpowers/specs/2026-10-02-dashboard-shadcn-redesign-design.md`: Geist, monochrome, no decorative cards or icons, no em dashes in copy.
- Problem types use the existing `urn:gauntlet:problem:<name>` form and pass through `safeProblem`.
- `mode` defaults to `none`; configurations without `auth` behave exactly as today.
- `GAUNTLET_AUTH_SECRET` comes only from the environment, decodes (base64url or hex) to at least 32 bytes, and is required when `mode` is not `none`.
- Credentials, cookies and tokens never appear in logs, problem details, run records or URLs.
- `/health` and `/ready` stay unauthenticated.
- Every PR that changes released paths adds a `.changes/<name>.md` change file (`CONTRIBUTING.md`, "Change files"); do not edit `CHANGELOG.md` by hand.

## Review Focus

- A configuration with `auth.mode: password` and a missing or short `GAUNTLET_AUTH_SECRET` must fail at startup, never start unprotected. (Task 2)
- A widget logged in over plain HTTP (`publicUrl` `http://...`) must keep working across reloads via the bearer fallback, and a stored token that went stale (secret rotated, password changed) must return the panel to its login form instead of an error loop. (Tasks 8, 9)
- A cookie-authenticated `POST` from a foreign `Origin` (or with no `Origin`) must get `403`, while the same request with a bearer token and the dashboard's own same-origin `POST` succeed. (Task 4)
- Username probing: an unknown username and a wrong password produce the same `401` body and comparable timing. (Task 5)
- A session expiring while the user is on an operation screen returns to the login screen and, after login, to the same URL with the route intact. (Task 7)

---

## File Structure

Server (`apps/server/src/auth/`):

- `secret.ts`: decode `GAUNTLET_AUTH_SECRET`, derive per-kind HKDF keys.
- `tokens.ts`: `g1.<kind>.<payload>.<sig>` sign/verify.
- `passwords.ts`: `scrypt$...` hash and verify.
- `api-tokens.ts`: `gat_` token generation and `sha256$...` hash.
- `config.ts`: parse and validate the `auth` YAML section into `AuthConfiguration`.
- `principal.ts`: `Principal` type, request decoration, `AsyncLocalStorage` for MCP.
- `authenticator.ts`: credential resolution (bearer, cookie), `pv` fingerprints, password login.
- `guard.ts`: `onRequest` hook with public-path matrix and CSRF check.
- `rate-limit.ts`: in-memory failed-login limiter.
- `routes.ts`: `/api/v1/auth/session|login|logout`, cookies.
- `index.ts`: `registerAuth(app, options)` composing the above.
- `apps/server/src/auth-cli.ts`: `hash-password`, `create-token`, `generate-secret`.

Dashboard (`apps/dashboard/src/`):

- `auth.ts`: session client, token store, `unauthenticated` event.
- `api.ts`: bearer header, `401` notification, `auth` endpoints.
- `app/LoginForm.tsx`: shared form (dashboard and panel).
- `app/LoginScreen.tsx`: full-screen dashboard login.
- `app/useAuthSession.ts`: session state hook.
- `app/App.tsx`, `app/AppSidebar.tsx`, `app/McpConnection.tsx`: gate, log out, copy.
- `widget/Panel.tsx`, `widget/PanelHeader.tsx`, `widget/PanelLogin.tsx`: panel gate and log out.

---

### Task 1: Token, password and API-token primitives

**Files:**
- Create: `apps/server/src/auth/secret.ts`, `apps/server/src/auth/tokens.ts`, `apps/server/src/auth/passwords.ts`, `apps/server/src/auth/api-tokens.ts`
- Test: `apps/server/test/auth-tokens.test.ts`, `apps/server/test/auth-passwords.test.ts`

**Interfaces:**
- Produces:
  - `decodeAuthSecret(value: string): Buffer` (throws `TypeError("Invalid authentication secret")` under 32 bytes or bad encoding; accepts 64+ hex chars or base64url).
  - `type TokenKind = "s" | "a" | "r" | "c"`; `interface TokenKeys { readonly [kind in TokenKind]: Buffer }`; `deriveTokenKeys(secret: Buffer): TokenKeys` (HKDF-SHA256, empty salt, `info = "gauntlet/<kind>/v1"`, 32 bytes).
  - `signToken(keys: TokenKeys, kind: TokenKind, payload: TokenPayload): string`; `verifyToken(keys: TokenKeys, kind: TokenKind, token: string, now: Date): TokenPayload | undefined`, with `interface TokenPayload { readonly sub: string; readonly iat: number; readonly exp: number; readonly pv?: string; readonly [key: string]: unknown }` (seconds since epoch). Rejects wrong prefix/kind, bad base64url, non-object JSON, missing `sub/iat/exp`, `exp <= now`, tokens over 4096 chars.
  - `hashPassword(password: string, salt?: Buffer): Promise<string>` producing `scrypt$16384$8$1$<salt>$<hash>` (32-byte hash, 16-byte salt); `parsePasswordHash(value: string): PasswordHash | undefined`; `verifyPassword(password: string, hash: PasswordHash): Promise<boolean>`; `DUMMY_PASSWORD_HASH: PasswordHash` for constant-time unknown-user checks. Parameters bounded: `N` power of two in `[2^14, 2^20]`, `r` in `[1, 32]`, `p` in `[1, 16]`.
  - `createApiToken(): { token: string; hash: string }` (`gat_` + 32 bytes base64url, `sha256$<b64url>`); `hashApiToken(token: string): string`; `isApiTokenHash(value: string): boolean`.

- [ ] **Step 1: Write failing tests** covering: round trip; tampered payload or signature; a session token verified as `r`; expiry at exactly `exp`; signature by a different secret; `decodeAuthSecret` with 31-byte, 32-byte hex and base64url input; `hashPassword` → `verifyPassword` true/false; `parsePasswordHash` rejecting out-of-range parameters and malformed strings; `createApiToken` hash matches `hashApiToken(token)`.

```ts
test("a session token never verifies as a refresh token", () => {
  const keys = deriveTokenKeys(decodeAuthSecret("a".repeat(64)));
  const token = signToken(keys, "s", { sub: "user:anna", iat: 1, exp: 4_000_000_000 });
  assert.equal(verifyToken(keys, "r", token, new Date(2_000_000)), undefined);
  assert.equal(verifyToken(keys, "s", token, new Date(2_000_000))?.sub, "user:anna");
});
```

- [ ] **Step 2: Run** `pnpm --filter @8lines/gauntlet-server exec tsx --test test/auth-tokens.test.ts test/auth-passwords.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** with `createHmac`, `hkdfSync`, `scrypt` (promisified, `maxmem: 256 * N * r`), `timingSafeEqual` on equal-length buffers.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(auth): sign tokens and hash passwords with node:crypto`.

### Task 2: `auth` configuration and secret wiring

**Files:**
- Create: `apps/server/src/auth/config.ts`
- Modify: `apps/server/src/config.ts` (allow `auth`, add `auth: AuthConfiguration` to `ServerConfiguration`), `apps/server/src/main.ts` (read `GAUNTLET_AUTH_SECRET`, pass `auth` to `createApp`), `apps/server/src/app.ts` (`CreateAppOptions.auth`), `config/gauntlet-config-v1.schema.json`, `deploy/compose/gauntlet-config-v1.schema.json`
- Test: `apps/server/test/auth-config.test.ts`, `apps/server/test/config-schema.test.ts`, `apps/server/test/main.test.ts`

**Interfaces:**
- Produces:

```ts
export type AuthConfiguration =
  | { readonly mode: "none" }
  | {
      readonly mode: "password";
      readonly publicUrl: URL;              // origin only
      readonly sessionTtlSeconds: number;   // 300..2_592_000, default 43_200
      readonly password:
        | { readonly kind: "shared"; readonly hash: PasswordHash }
        | { readonly kind: "users"; readonly users: ReadonlyMap<string, PasswordHash> };
      readonly tokens: ReadonlyMap<string, string>; // sha256 hash -> token name
    };
export function authConfiguration(value: unknown): AuthConfiguration; // throws GauntletConfigurationError("invalid-document")
export interface AuthOptions { readonly configuration: AuthConfiguration; readonly secret?: Buffer }
```

- `createApp({ ..., auth?: AuthOptions })`: omitted means `{ configuration: { mode: "none" } }`. `mode !== "none"` without `secret` throws `TypeError("Authentication requires GAUNTLET_AUTH_SECRET")`.
- `main.ts`: `authSecret(environment)` returns `Buffer | undefined` via `decodeAuthSecret`; logs `process.emitWarning("Gauntlet authentication is disabled", { code: "GAUNTLET_AUTH_DISABLED" })` once when mode is `none`.

- [ ] **Step 1: Failing tests**: `none` with extra keys rejected; missing `publicUrl` rejected; `publicUrl` with path/query rejected; `shared` and `users` together rejected; duplicate usernames/token names/hashes rejected; `sessionTtl: "4m"` and `"31d"` rejected, `"12h"` gives 43200; schema accepts the spec example and rejects `mode: oidc`; `createConfiguredApp` fails without secret and with a 16-byte secret.
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement** using the existing `ownDataRecord`/`exactKeys` style (export them from `config.ts` or duplicate the minimal pieces into `auth/config.ts`); add `auth` `$defs` to both schema copies (`deploy/compose` copy must stay byte-identical; `scripts/verify-compose-distribution.mjs` checks it).
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(auth): configure authentication mode, users and API tokens`.

### Task 3: Principal, authenticator and actor stamping

**Files:**
- Create: `apps/server/src/auth/principal.ts`, `apps/server/src/auth/authenticator.ts`
- Modify: `apps/server/src/routes.ts` (pass principal into run creation), `apps/server/src/run-proxy-service.ts` (`create(targetId, operationId, request, actor?)`), `apps/server/src/mcp.ts` (read actor from `AsyncLocalStorage`)
- Test: `apps/server/test/auth-authenticator.test.ts`, extend `apps/server/test/routes.integration.test.ts`

**Interfaces:**

```ts
export type Principal =
  | { readonly kind: "anonymous" }
  | { readonly kind: "shared"; readonly id: "shared"; readonly displayName: "Shared password" }
  | { readonly kind: "user"; readonly id: `user:${string}`; readonly displayName: string }
  | { readonly kind: "token"; readonly id: `token:${string}`; readonly displayName: string };
export const principalStorage: AsyncLocalStorage<Principal>;
export function requestPrincipal(request: FastifyRequest): Principal; // anonymous when unset

export interface Authenticator {
  readonly configuration: Exclude<AuthConfiguration, { mode: "none" }>;
  /** Resolves a bearer or cookie credential; `via` drives the CSRF check. */
  authenticate(request: FastifyRequest, now: Date): { principal: Principal; via: "bearer" | "cookie"; expiresAt?: Date } | undefined;
  login(username: string | undefined, password: string, now: Date): Promise<{ principal: Principal; token: string; expiresAt: Date } | undefined>;
  sessionFor(principal: Principal, now: Date): { token: string; expiresAt: Date };
}
export function createAuthenticator(configuration: ..., secret: Buffer): Authenticator;
```

- `pv` = first 16 base64url chars of HMAC-SHA256(`s` key, `"pv:" + principal.id + ":" + <password hash string>`). Verification recomputes it; a user removed from configuration or a changed hash fails.
- Login for an unknown user verifies against `DUMMY_PASSWORD_HASH` and returns `undefined`.
- Bearer `gat_...` resolves through `tokens` map; bearer `g1.s` / `g1.a` verify as session/access; any other bearer value is rejected (not a fallback to cookie).
- Actor stamping: `runs.create` receives `actor?: { id: string; displayName: string }`; when present, the forwarded request's `context` becomes `{ ...context, actor }`, creating `context: { requestId: "gauntlet-<uuid>" , actor }` when the caller sent none. The REST route passes `requestPrincipal(request)` unless anonymous; MCP's `gauntlet_create_run` uses `principalStorage.getStore()`.

- [ ] **Step 1: Failing tests**: shared login with wrong/right password; users login with unknown user returns `undefined`; session from user `anna` stops verifying after her hash changes; `gat_` lookup; malformed bearer returns `undefined` even with a valid cookie; REST run creation with a user session forwards `context.actor.id === "user:anna"` to the adapter (use the existing fake adapter fetch in `routes.integration.test.ts`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm --filter @8lines/gauntlet-server test`. Expected: PASS (existing suites unchanged with `mode: none`).
- [ ] **Step 5: Commit** `feat(auth): resolve principals and record them as run actors`.

### Task 4: Request guard and CSRF

**Files:**
- Create: `apps/server/src/auth/guard.ts`, `apps/server/src/auth/index.ts`
- Modify: `apps/server/src/app.ts` (call `registerAuth` after `configureProblemResponses`, before routes), `apps/server/src/safe-problem.ts` (titles), `apps/server/src/problem-response.ts` (problem constants), `apps/server/src/mcp.ts` (run the MCP handler inside `principalStorage.run`)
- Test: `apps/server/test/auth-guard.test.ts`

**Interfaces:**
- Problems: `UNAUTHENTICATED_PROBLEM` (`urn:gauntlet:problem:unauthenticated`, 401, "Authentication required"), `INVALID_CREDENTIALS_PROBLEM` (`invalid-credentials`, 401, "Invalid credentials"), `RATE_LIMITED_PROBLEM` (`rate-limited`, 429, "Too many attempts"), `CSRF_PROBLEM` (`cross-site-request`, 403, "Cross-site request rejected").
- `registerAuth(app: FastifyInstance, options: { authenticator?: Authenticator; clock: () => Date }): void` registers the guard and the routes of Task 5; with no authenticator it registers only `GET /api/v1/auth/session` returning mode `none`.
- Guard: protected iff path is `/mcp` or starts with `/api/` and does not start with `/api/v1/auth/`. Everything else passes. On success decorates the request principal. CSRF: `via === "cookie"` and method not in `GET/HEAD/OPTIONS` requires `request.headers.origin === publicUrl.origin`. Also applies to `POST /api/v1/auth/logout`.
- `/mcp` `401` is a JSON-RPC body `{ jsonrpc: "2.0", error: { code: -32001, message: "Authentication required" } }` with `www-authenticate: Bearer`.

- [ ] **Step 1: Failing tests** with `createApp` + `inject`: matrix of `/health`, `/ready`, `/`, `/widget/config.json`, `/api/v1/auth/session` → not 401; `/api/v1/targets`, `/api/v1/targets/x/runs/y`, `/mcp` → 401 without credentials and 200/404-from-handler with a bearer session; cookie `POST` with `origin: https://evil.test` → 403, with no origin → 403, with `publicUrl` origin → passes; bearer `POST` with foreign origin → passes CSRF; `mode: none` → all existing behaviour (run `routes.integration.test.ts` unchanged).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** server suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(auth): require credentials for the API and MCP when authentication is on`.

### Task 5: Login, session and logout routes with rate limiting

**Files:**
- Create: `apps/server/src/auth/routes.ts`, `apps/server/src/auth/rate-limit.ts`
- Modify: `apps/server/src/problem-response.ts` (`knownRoutes` entries for the three auth routes)
- Test: `apps/server/test/auth-routes.test.ts`

**Interfaces:**
- `GET /api/v1/auth/session` → `200 { mode: "none" | "password", loginFields: [] | ["password"] | ["username","password"], principal: { id, kind, displayName } | null, expiresAt: string | null }`, `cache-control: no-store`. Uses `authenticate` (bearer or cookie). Anonymous principal is reported as `null` in mode `none` too.
- `POST /api/v1/auth/login` body `{ username?: string, password: string, surface: "dashboard" | "widget" }` (strict; `username` required iff users mode; strings 1..256 chars) → `200 { principal, token, expiresAt }` + `set-cookie`, or `400 invalid-request`, `401 invalid-credentials`, `429 rate-limited` with `retry-after`. Response `cache-control: no-store`.
- Cookies: name `gauntlet_session`.
  - dashboard: `HttpOnly; SameSite=Lax; Path=/; Max-Age=<ttl>` + `; Secure` when `publicUrl.protocol === "https:"`.
  - widget + https: `HttpOnly; Secure; SameSite=None; Partitioned; Path=/; Max-Age=<ttl>`.
  - widget + http: no `set-cookie`.
- `POST /api/v1/auth/logout` → `204`, `set-cookie` clearing both variants (`Max-Age=0`, matching attributes). Does not require a valid session.
- `createLoginRateLimiter({ limit: 10, windowMs: 300_000, maxKeys: 10_000 })` → `{ blocked(keys, now): number | undefined /* retry-after s */, fail(keys, now): void, reset(keys): void }`; keys are `ip:<request.ip>` and `user:<username or "shared">`. Successful login resets the username key only.

- [ ] **Step 1: Failing tests**: shared login sets Lax cookie without `Secure` on http publicUrl; https publicUrl adds `Secure`; widget surface over https sets `SameSite=None; Partitioned`; widget over http sets no cookie but returns token; session with cookie and with bearer both return principal; unknown user and wrong password return identical bodies; 11th failure returns 429 with `retry-after`; logout clears cookie and `/api/v1/auth/session` then reports `principal: null`; mode `none` session returns `{ mode: "none", loginFields: [], principal: null, expiresAt: null }`; login in mode `none` → 404 `route-not-found`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** server suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(auth): log in with a password and keep the session in a cookie or bearer token`.

### Task 6: CLI helpers

**Files:**
- Create: `apps/server/src/auth-cli.ts`
- Modify: `deploy/compose/gauntlet` (`auth` command → `docker compose run --rm --no-deps -T gauntlet node dist/auth-cli.js "$@"`), `deploy/compose/test/wrapper.test.mjs`
- Test: `apps/server/test/auth-cli.test.ts`

**Interfaces:**
- `node dist/auth-cli.js hash-password` reads stdin to EOF (trailing `\n`/`\r\n` stripped, empty rejected) and prints the hash; `create-token <name>` validates `name` with `isProtocolId`, prints `token: gat_...` and the YAML entry; `generate-secret` prints 32 random bytes base64url. Exit code 64 on usage errors. Exported `runAuthCli(argv, io): Promise<number>` for tests.

- [ ] **Step 1: Failing tests** for each subcommand through `runAuthCli` with in-memory io; wrapper test that `gauntlet auth hash-password` reaches `docker compose run` (follow the existing fake-docker pattern in `wrapper.test.mjs`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** server suite and `pnpm test:compose:distribution`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(auth): add hash-password, create-token and generate-secret commands`.

### Task 7: Dashboard login

**Files:**
- Create: `apps/dashboard/src/auth.ts`, `apps/dashboard/src/app/useAuthSession.ts`, `apps/dashboard/src/app/LoginForm.tsx`, `apps/dashboard/src/app/LoginScreen.tsx`
- Modify: `apps/dashboard/src/api.ts`, `apps/dashboard/src/app/App.tsx`, `apps/dashboard/src/app/AppSidebar.tsx`, `apps/dashboard/src/app/McpConnection.tsx`, `apps/dashboard/src/copy.ts`, `apps/dashboard/e2e/api-fixture.ts`
- Test: `apps/dashboard/test/auth.test.ts`, `apps/dashboard/e2e/auth.spec.ts`, `apps/dashboard/e2e/accessibility.spec.ts`

**Interfaces:**

```ts
// auth.ts
export interface AuthPrincipal { readonly id: string; readonly kind: string; readonly displayName: string }
export interface AuthSession {
  readonly mode: "none" | "password";
  readonly loginFields: readonly ("username" | "password")[];
  readonly principal: AuthPrincipal | null;
  readonly expiresAt: string | null;
}
export interface TokenStore { read(): string | undefined; write(token: string): void; clear(): void }
export const memoryTokenStore: () => TokenStore;          // dashboard: never persists
export function localTokenStore(storage: Storage, key = "gauntlet.session.v1"): TokenStore;
export function configureAuthTransport(store: TokenStore): void;   // api.ts reads it
export function onUnauthenticated(listener: () => void): () => void;
// api.ts additions
api.session(): Promise<Result<AuthSession>>;
api.login(body: { username?: string; password: string; surface: "dashboard" | "widget" }): Promise<Result<{ principal: AuthPrincipal; token: string; expiresAt: string }>>;
api.logout(): Promise<Result<void>>;
```

- `request()` adds `authorization: Bearer <token>` when the store has one, and on any `401` whose problem type is `urn:gauntlet:problem:unauthenticated` clears the store and emits `unauthenticated`.
- `useAuthSession()` → `{ state: "loading" | "ready" | "failed", session, problem, refresh, signedIn(session), signOut() }`; subscribes to `onUnauthenticated` and sets `principal: null`.
- `App` renders `LoginScreen` when `mode !== "none" && principal === null`, `LoadingState` while loading, `LoadFailed` on failure; otherwise the existing shell. Targets polling (`useTargets`) only starts inside the authenticated shell (move the shell into an `AuthenticatedApp` component).
- `LoginForm` props `{ fields, surface, onSignedIn(session), compact? }`: `Label` + `Input` (autocomplete `username` / `current-password`), submit `Button` with pending state, `Alert` for `invalid-credentials` ("Incorrect password." / "Incorrect username or password.") and `rate-limited` ("Too many attempts. Try again in a few minutes."). Focuses the first field on mount.
- `LoginScreen`: centered column with `GauntletMark`, heading "Sign in to Gauntlet", `LoginForm`.
- Sidebar footer: principal `displayName` and a "Log out" button (only when `mode !== "none"`), calling `api.logout()` then `signOut()`.
- `McpConnection`: when authentication is on, add copy "This Gauntlet requires authentication. Add an API token header:" and a snippet with `"headers": { "Authorization": "Bearer <api token>" }`.
- `api-fixture.ts`: answer `GET /api/v1/auth/session` with mode `none`; add an `auth` option for the new spec.

- [ ] **Step 1: Failing unit tests** (`auth.test.ts`): bearer header added when store has a token; `401 unauthenticated` clears the store and notifies; `401 invalid-credentials` from login does not notify.
- [ ] **Step 2: Failing e2e** (`auth.spec.ts`, desktop + mobile projects): mode password shows login screen at `/t/shop/o/op`; wrong password shows the error; right password lands on the same URL; a later `401` from `/api/v1/targets` polling returns to the login screen; "Log out" calls logout and shows login screen. Add login screen to the axe scan.
- [ ] **Step 3: Run** `pnpm --filter @8lines/gauntlet-dashboard test` and `pnpm dashboard:test:e2e`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** both suites plus `pnpm --filter @8lines/gauntlet-dashboard typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(dashboard): sign in with a password before the dashboard loads`.

### Task 8: Widget panel login with cookie and token fallback

**Files:**
- Create: `apps/dashboard/src/widget/PanelLogin.tsx`, `apps/dashboard/src/widget/usePanelAuth.ts`
- Modify: `apps/dashboard/src/widget/Panel.tsx`, `apps/dashboard/src/widget/PanelHeader.tsx`, `apps/dashboard/src/widget/main.tsx`
- Test: `apps/dashboard/test/widget-auth.test.ts`

**Interfaces:**
- `widget/main.tsx` calls `configureAuthTransport(localTokenStore(localStorage))` (falls back to `memoryTokenStore()` when storage throws).
- `completeWidgetLogin(result, store, probe: () => Promise<Result<AuthSession>>): Promise<AuthSession>`: probe once without a token; if the probe returns the principal, `store.clear()` and return it; otherwise `store.write(result.token)` and return a session built from the login result.
- `usePanelAuth()` wraps `useAuthSession` with `completeWidgetLogin`.
- `Panel` (connected state) shows `PanelLogin` (compact `LoginForm`, heading "Sign in to Gauntlet") when `mode !== "none" && principal === null`, before `ConnectedPanel` mounts; nothing auth-related is sent over the channel.
- `PanelHeader` gets an optional `onLogOut` rendering a "Log out" item (when signed in under `mode !== "none"`).

- [ ] **Step 1: Failing unit tests** for `completeWidgetLogin`: cookie works → store cleared; probe returns `principal: null` → token written; probe network failure → token written.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** dashboard unit suite and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(widget): sign in inside the panel and keep the session across reloads`.

### Task 9: Widget end-to-end with authentication over HTTP

**Files:**
- Modify: `apps/dashboard/e2e-widget/stack.mjs` (second control plane on `http://localhost:4413` with `auth: { mode: password, publicUrl: http://localhost:4413, shared }`, same adapter, host page variant on `127.0.0.1:4414` pointing at it), `apps/dashboard/e2e-widget/widget.spec.ts`

- [ ] **Step 1: Failing e2e**: open the host on `:4414`, open the widget, see "Sign in to Gauntlet", submit wrong password (error), right password (operations list); reload the host page and reopen: still signed in (token fallback, no login form); clear the panel's token by rotating nothing but calling logout from the panel menu: login form returns.
- [ ] **Step 2: Run** `pnpm build && pnpm widget:test:e2e:panel`. Expected: FAIL.
- [ ] **Step 3: Fix** whatever the e2e exposes (stale token → login form, see Review Focus).
- [ ] **Step 4: Run.** Expected: PASS, existing widget specs unchanged.
- [ ] **Step 5: Commit** `test(widget): sign in to an authenticated Gauntlet from a cross-site host over HTTP`.

### Task 10: Documentation, examples and change file

**Files:**
- Create: `docs/deployment/authentication.md`, `.changes/built-in-password-authentication.md`
- Modify: `SECURITY.md`, `docs/mcp.md`, `docs/integrations/widget.md`, `docs/architecture.md`, `docs/safety/non-production-boundary.md`, `deploy/compose/config.example.yaml`, `deploy/compose/.env.example` and `deploy/compose/compose.yaml` (`GAUNTLET_AUTH_SECRET` passthrough, empty default), `docs/documentation-manifest.json` (if new docs must be registered), deployment index docs

- Change file:

```md
---
type: added
units:
  gauntlet: minor
---
Gauntlet can require a password, shared or per user, and static API tokens for the dashboard, widget, REST API and MCP endpoint.
```

- [ ] **Step 1:** Write `docs/deployment/authentication.md`: enabling password mode, generating the secret and hashes with the CLI, users vs shared, API tokens for MCP and CI, cookie vs token behaviour in the widget, HTTP caveats, logout semantics and secret rotation, that MCP OAuth sign-in is not available yet.
- [ ] **Step 2:** Update `SECURITY.md` and the safety/architecture docs: authentication is now optional and built in; a private boundary is still recommended; stateless logout limitation.
- [ ] **Step 3:** Run `pnpm docs:check`, `pnpm test:compose:distribution`, `git fetch origin main && pnpm release:changes --check` (after committing). Expected: PASS.
- [ ] **Step 4: Commit** `docs(auth): document password authentication and API tokens`.

### Task 11: Full verification

- [ ] Run `pnpm check`, `pnpm dashboard:test:e2e`, `pnpm widget:test:e2e`, `pnpm widget:test:e2e:panel`, `pnpm docs:check`. Expected: all PASS. Record any environment-limited check as unresolved, never as passing.
