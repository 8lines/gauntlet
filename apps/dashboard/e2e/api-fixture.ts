import type { Page } from "@playwright/test";
import {
  computeRevision,
  manifestSemanticsAreValid,
  operationSemanticsAreValid,
  runSemanticsAreValid,
  type AdapterManifest,
  type JsonObject,
  type OperationDefinition,
  type Run,
} from "@8lines/gauntlet-protocol";
import manifestDocument from "@8lines/gauntlet-protocol/fixtures/v1/manifest.valid.json" with { type: "json" };
import operationDocument from "@8lines/gauntlet-protocol/fixtures/v1/operation.valid.json" with { type: "json" };
import uploadDocument from "@8lines/gauntlet-protocol/fixtures/v1/upload-response.valid.json" with { type: "json" };

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly fileNames?: readonly string[];
}

export interface BrowserFixtureState {
  readonly requests: readonly RecordedRequest[];
}

export interface ApiFixtureOptions {
  readonly operation: OperationDefinition;
  /**
   * `mobile`: runs finish at once. `desktop`: the first run stays running until cancelled, the second finishes with rich results.
   * `run-url`: a run stays running for its first two `GET`s, then finishes with a follow-up into the same operation.
   */
  readonly scenario: "mobile" | "desktop" | "run-url";
  readonly targetLabel?: string;
  /** When set, every create-run response waits for this promise to settle. */
  readonly createRunGate?: Promise<unknown>;
  /** Password authentication; omitted means authentication is off. */
  readonly auth?: { readonly password: string; readonly username?: string; readonly logoutStatus?: number };
}

export interface ApiFixtureControl {
  /** Makes the current session invalid, as an expiry or a rotated secret would. */
  expireSession(): void;
}

export function operationWithRevision(
  changes: Partial<Omit<OperationDefinition, "revision">>,
): OperationDefinition {
  const { revision: _revision, ...canonical } = structuredClone(operationDocument);
  const draft = Object.fromEntries(
    Object.entries({ ...canonical, ...changes }).filter(([, value]) => value !== undefined),
  ) as JsonObject;
  const operation = Object.freeze({ ...draft, revision: computeRevision(draft) }) as unknown as OperationDefinition;
  if (!operationSemanticsAreValid(operation)) throw new TypeError("Browser operation fixture is invalid");
  return operation;
}

const emptyObjectSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {},
  additionalProperties: false,
} as const);

export const destructiveOperation = operationWithRevision({
  id: "browser-delete-fixture",
  label: "Delete test data",
  description: "Browser case for confirming a destructive operation.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      roles: {
        type: "array",
        title: "Role",
        items: { type: "string", enum: ["viewer", "auditor"] },
        uniqueItems: true,
      },
    },
    additionalProperties: false,
  },
  inputHandling: undefined,
  uiSchema: {
    profile: "tc-rich-forms@1",
    root: {
      type: "field",
      pointer: "/roles",
      widget: "multi-select",
      label: "Role",
    },
  },
  dataSources: [],
  presets: [],
  execution: {
    impact: "destructive",
    confirmationRequired: true,
    dryRunSupported: true,
    idempotency: "required",
    cancellationSupported: false,
    timeoutSeconds: 120,
    concurrency: "queue",
  },
  output: { schema: emptyObjectSchema },
});

export const desktopOperation = operationWithRevision({
  id: "browser-workflow-fixture",
  label: "Process test file",
  description: "Browser case for upload, cancellation and result presentation.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["attachment"],
    properties: {
      attachment: {
        type: "object",
        title: "Attachment",
        required: ["kind", "uploadId", "name", "mediaType", "sizeBytes", "expiresAt"],
        properties: {
          kind: { const: "file" },
          uploadId: { type: "string" },
          name: { type: "string" },
          mediaType: { type: "string" },
          sizeBytes: { type: "integer", minimum: 0 },
          sha256: { type: "string" },
          expiresAt: { type: "string", format: "date-time" },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  inputHandling: {
    rules: [{
      kind: "file",
      schemaPointer: "/properties/attachment",
      multiple: false,
      mediaTypes: ["text/plain"],
      maxBytes: 1024,
    }],
  },
  uiSchema: {
    profile: "tc-rich-forms@1",
    root: {
      type: "field",
      pointer: "/attachment",
      widget: "file",
      label: "Attachment",
    },
  },
  dataSources: [],
  presets: [],
  execution: {
    impact: "write",
    confirmationRequired: true,
    dryRunSupported: false,
    idempotency: "required",
    cancellationSupported: true,
    timeoutSeconds: 120,
    concurrency: "queue",
  },
  output: { schema: emptyObjectSchema },
});

export const followUpOperation = operationWithRevision({
  id: "browser-invite-fixture",
  label: "Invite test user",
  description: "Browser case for run URLs and follow-ups into the same operation.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      email: { type: "string", title: "Email" },
    },
    additionalProperties: false,
  },
  inputHandling: undefined,
  uiSchema: {
    profile: "tc-rich-forms@1",
    root: {
      type: "field",
      pointer: "/email",
      widget: "text",
      label: "Email",
    },
  },
  dataSources: [],
  presets: [],
  execution: {
    impact: "write",
    confirmationRequired: false,
    dryRunSupported: false,
    idempotency: "required",
    cancellationSupported: false,
    timeoutSeconds: 120,
    concurrency: "queue",
  },
  output: { schema: emptyObjectSchema },
});

/** The follow-up a finished `run-url` run offers: the same operation, prefilled with this input. */
export const followUpInput = Object.freeze({ email: "next@acme.test" });

function manifestFor(operation: OperationDefinition): AdapterManifest {
  const { manifestRevision: _revision, ...canonical } = structuredClone(manifestDocument);
  const capabilities = [...new Set([...canonical.capabilities, "tc-run-cancellation@1"])] as AdapterManifest["capabilities"];
  const draft = {
    ...canonical,
    capabilities,
    operations: [{
      id: operation.id,
      revision: operation.revision,
      label: operation.label,
      featureId: operation.featureId,
      availability: { state: "available" as const },
      ...(operation.requirements === undefined ? {} : { requirements: operation.requirements }),
    }],
  } as unknown as JsonObject;
  const manifest = Object.freeze({
    ...draft,
    manifestRevision: computeRevision(draft, "manifestRevision"),
  }) as unknown as AdapterManifest;
  if (!manifestSemanticsAreValid(manifest)) throw new TypeError("Browser manifest fixture is invalid");
  return manifest;
}

function verifiedRun(operation: OperationDefinition, run: Run): Run {
  if (!runSemanticsAreValid(run, {
    operationId: operation.id,
    operationRevision: operation.revision,
    operationIds: [operation.id],
  })) throw new TypeError("Browser run fixture is invalid");
  return run;
}

function activeRun(operation: OperationDefinition): Run {
  return verifiedRun(operation, {
    id: "browser-run-01",
    operationId: operation.id,
    operationRevision: operation.revision,
    sequence: 1,
    state: "running",
    createdAt: "2026-09-03T12:00:00Z",
    updatedAt: "2026-09-03T12:00:01Z",
    startedAt: "2026-09-03T12:00:01Z",
    progress: {
      current: 1,
      total: 3,
      phase: "processing",
      message: "Processing file",
      updatedAt: "2026-09-03T12:00:01Z",
    },
    summary: { title: "Processing", tone: "neutral" },
    artifacts: [],
    actions: [],
  });
}

function succeededRun(operation: OperationDefinition, rich: boolean): Run {
  const longValue = "value-without-spaces-".repeat(18);
  return verifiedRun(operation, {
    id: "browser-run-01",
    operationId: operation.id,
    operationRevision: operation.revision,
    sequence: 2,
    state: "succeeded",
    createdAt: "2026-09-03T12:00:00Z",
    updatedAt: "2026-09-03T12:00:03Z",
    startedAt: "2026-09-03T12:00:01Z",
    completedAt: "2026-09-03T12:00:03Z",
    summary: { title: "Processing finished", message: "Test data is ready.", tone: "success" },
    output: {},
    artifacts: rich ? [
      {
        id: "wide-table",
        kind: "table",
        title: "Wide table",
        columns: Array.from({ length: 8 }, (_, index) => ({ key: `column${index}`, label: `Column ${index + 1}` })),
        rows: [Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`column${index}`, `${index}-${longValue}`]))],
      },
      {
        id: "details",
        kind: "key-value",
        title: "Details",
        entries: [{ key: "long", label: "Long value", value: longValue }],
      },
      {
        id: "timeline",
        kind: "timeline",
        title: "Timeline",
        items: [{
          timestamp: "2026-09-03T12:00:03Z",
          title: "Done",
          description: longValue,
        }],
      },
      {
        id: "log",
        kind: "log",
        title: "Log",
        entries: [{ timestamp: "2026-09-03T12:00:03Z", level: "info", message: longValue }],
      },
      { id: "browser-session", kind: "browser-launch", label: "Open test session" },
    ] : [],
    actions: rich ? [
      {
        kind: "invoke-operation",
        label: "Reuse the result",
        operationId: operation.id,
        input: { attachment: uploadDocument.file },
      },
      { kind: "open-link", label: "Result documentation", url: "https://docs.example.test/result" },
      { kind: "browser-launch", label: "Open test session", artifactId: "browser-session" },
    ] : [],
  });
}

function followUpRun(operation: OperationDefinition): Run {
  return verifiedRun(operation, {
    id: "browser-run-01",
    operationId: operation.id,
    operationRevision: operation.revision,
    sequence: 3,
    state: "succeeded",
    createdAt: "2026-09-03T12:00:00Z",
    updatedAt: "2026-09-03T12:00:05Z",
    startedAt: "2026-09-03T12:00:01Z",
    completedAt: "2026-09-03T12:00:05Z",
    summary: { title: "Invitation sent", tone: "success" },
    output: {},
    artifacts: [],
    actions: [{
      kind: "invoke-operation",
      label: "Invite another user",
      operationId: operation.id,
      input: followUpInput,
    }],
  });
}

/** A run with its own id and summary title, for cases that move between several runs of one operation. */
export function namedRun(operation: OperationDefinition, id: string, state: "running" | "succeeded", title: string): Run {
  return verifiedRun(operation, {
    id,
    operationId: operation.id,
    operationRevision: operation.revision,
    sequence: 1,
    state,
    createdAt: "2026-09-03T12:00:00Z",
    updatedAt: "2026-09-03T12:00:04Z",
    startedAt: "2026-09-03T12:00:01Z",
    ...(state === "succeeded" ? { completedAt: "2026-09-03T12:00:04Z", output: {} } : {}),
    summary: { title, tone: state === "succeeded" ? "success" : "neutral" },
    artifacts: [],
    actions: [],
  });
}

function cancelledRun(operation: OperationDefinition): Run {
  return verifiedRun(operation, {
    id: "browser-run-01",
    operationId: operation.id,
    operationRevision: operation.revision,
    sequence: 2,
    state: "cancelled",
    createdAt: "2026-09-03T12:00:00Z",
    updatedAt: "2026-09-03T12:00:02Z",
    startedAt: "2026-09-03T12:00:01Z",
    completedAt: "2026-09-03T12:00:02Z",
    artifacts: [],
    actions: [],
    problem: {
      type: "urn:gauntlet:problem:run-cancelled",
      title: "Run cancelled",
      status: 409,
    },
  });
}

export async function installApiFixture(page: Page, options: ApiFixtureOptions): Promise<ApiFixtureControl> {
  const manifest = manifestFor(options.operation);
  let creates = 0;
  let polls = 0;
  let signedIn = false;
  const auth = options.auth;
  const loginFields = auth?.username === undefined ? ["password"] : ["username", "password"];
  const principal = auth?.username === undefined
    ? { kind: "shared", id: "shared", displayName: "Shared password" }
    : { kind: "user", id: `user:${auth.username}`, displayName: auth.username };

  await page.addInitScript(() => {
    const state: { requests: RecordedRequest[] } = { requests: [] };
    Object.defineProperty(globalThis, "__GAUNTLET_E2E__", { value: state, configurable: false });
    const browserFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : undefined;
      const url = new URL(request?.url ?? String(input), globalThis.location.href);
      if (url.pathname.startsWith("/api/v1/")) {
        const body = init?.body;
        let recordedBody: unknown;
        let fileNames: string[] | undefined;
        if (typeof body === "string") {
          try { recordedBody = JSON.parse(body); } catch { recordedBody = undefined; }
        } else if (body instanceof FormData) {
          fileNames = [...body.values()]
            .filter((value): value is File => value instanceof File)
            .map((file) => file.name);
        }
        state.requests.push({
          method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
          path: url.pathname,
          ...(recordedBody === undefined ? {} : { body: recordedBody }),
          ...(fileNames === undefined ? {} : { fileNames }),
        });
      }
      return browserFetch(input, init);
    };
  });

  await page.context().route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

    if (method === "GET" && url.pathname === "/api/v1/auth/session") {
      if (auth === undefined) return json({ mode: "none", loginFields: [], principal: null, expiresAt: null });
      return json({
        mode: "password",
        loginFields,
        principal: signedIn ? principal : null,
        expiresAt: signedIn ? "2026-09-04T00:00:00.000Z" : null,
      });
    }

    if (auth !== undefined && method === "POST" && url.pathname === "/api/v1/auth/login") {
      const body = request.postDataJSON() as { username?: string; password?: string };
      if (body.password !== auth.password || body.username !== auth.username) {
        return json({ type: "urn:gauntlet:problem:invalid-credentials", title: "Invalid credentials", status: 401 }, 401);
      }
      signedIn = true;
      // The dashboard keeps its session in the cookie and never reads the token.
      return json({ principal, token: "<fixture session token>", expiresAt: "2026-09-04T00:00:00.000Z" });
    }

    if (auth !== undefined && method === "POST" && url.pathname === "/api/v1/auth/logout") {
      if (auth.logoutStatus !== undefined) {
        return json({ type: "urn:gauntlet:problem:cross-site-request", title: "Cross-site request rejected", status: auth.logoutStatus }, auth.logoutStatus);
      }
      signedIn = false;
      return route.fulfill({ status: 204 });
    }

    if (auth !== undefined && !signedIn) {
      return json({ type: "urn:gauntlet:problem:unauthenticated", title: "Authentication required", status: 401 }, 401);
    }

    if (method === "GET" && url.pathname === "/api/v1/targets") {
      return json({
        targets: [{
          id: "browser-target",
          label: options.targetLabel ?? "Browser environment",
          expectedEnvironment: manifest.application.environment,
          tags: ["browser"],
          state: "online",
          manifest,
          refreshedAt: "2026-09-03T12:00:00Z",
        }],
      });
    }

    if (method === "GET" && url.pathname === `/api/v1/targets/browser-target/operations/${options.operation.id}`) {
      return json(options.operation);
    }

    if (method === "POST" && url.pathname === "/api/v1/targets/browser-target/uploads") {
      return json(uploadDocument);
    }

    if (method === "POST" && url.pathname === `/api/v1/targets/browser-target/operations/${options.operation.id}/runs`) {
      creates += 1;
      if (options.createRunGate !== undefined) await options.createRunGate;
      return json(options.scenario === "mobile" ? succeededRun(options.operation, false) : activeRun(options.operation), 202);
    }

    if (method === "GET" && url.pathname === "/api/v1/targets/browser-target/runs/browser-run-01") {
      polls += 1;
      if (options.scenario === "run-url") return json(polls > 2 ? followUpRun(options.operation) : activeRun(options.operation));
      return json(creates >= 2 && polls >= 1 ? succeededRun(options.operation, true) : activeRun(options.operation));
    }

    if (method === "GET" && /^\/api\/v1\/targets\/browser-target\/runs\/[^/]+$/.test(url.pathname)) {
      return json({
        type: "urn:gauntlet:problem:run-not-found",
        title: "Run not found",
        status: 404,
      }, 404);
    }

    if (method === "POST" && url.pathname === "/api/v1/targets/browser-target/runs/browser-run-01/cancel") {
      return json(cancelledRun(options.operation));
    }

    if (method === "POST" && url.pathname === "/api/v1/targets/browser-target/runs/browser-run-01/artifacts/browser-session/launch") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return json({
        url: "http://127.0.0.1:4173/t/launched-session",
        expiresAt: "2026-09-03T12:15:00Z",
        singleUse: true,
      });
    }

    return json({
      type: "urn:gauntlet:problem:route-not-found",
      title: "Route not found",
      status: 404,
    }, 404);
  });

  return { expireSession: () => { signedIn = false; } };
}

export function recordedState(page: Page): Promise<BrowserFixtureState> {
  return page.evaluate(() => {
    const state = (globalThis as typeof globalThis & { __GAUNTLET_E2E__?: BrowserFixtureState }).__GAUNTLET_E2E__;
    if (state === undefined) throw new Error("Browser API fixture state is unavailable");
    return structuredClone(state);
  });
}

export async function recordedRuns(page: Page): Promise<readonly Record<string, unknown>[]> {
  const state = await recordedState(page);
  return state.requests
    .filter(({ method, path }) => method === "POST" && /\/operations\/[^/]+\/runs$/.test(path))
    .map(({ body }) => body as Record<string, unknown>);
}
