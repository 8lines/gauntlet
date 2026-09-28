import {
  AdapterCatalogError,
  ownCanonicalAdapterHealth,
  ownCanonicalAdapterManifest,
  ownCanonicalDataSourcePage,
  ownCanonicalDataSourceResolveResponse,
  ownCanonicalOperationDefinition,
  ownCanonicalProblem,
  ownCanonicalRun,
  ownCanonicalRunEvent,
  ownCanonicalSessionLaunchResponse,
  ownCanonicalUploadResponse,
  createAjvSchemaValidator,
  type AdapterCatalog,
  type SchemaValidator,
} from "@8lines/gauntlet-typescript-core";
import {
  canonicalizeForRevision,
  isProtocolId,
  resolveSemanticsAreValid,
  runSemanticsAreValid,
  validateRunTransition,
  type AdapterManifest,
  type CoreCapabilityId,
  type JsonObject,
  type JsonValue,
  type OperationDefinition,
  type Problem,
  type ProtocolRequirements,
  type Run,
  type RunEvent,
  type SessionLaunchResponse,
} from "@8lines/gauntlet-protocol";
import { readJsonObject } from "./json.js";
import { readMultipartFile } from "./multipart.js";
import { isAdapterTarget, parseAdapterPath } from "./path.js";
import { jsonResponse, problem, problemResponse } from "./problems.js";

export type AdapterRequestBoundary =
  | { readonly kind: "raw"; readonly request: Request; readonly rawTarget: string }
  | {
      readonly kind: "trusted-normalized";
      readonly request: Request;
      readonly normalizedTarget: string;
    };

export type AdapterFetchHandler = (boundary: AdapterRequestBoundary) => Promise<Response>;

export interface AdapterFetchHandlerOptions {
  readonly enabled?: boolean;
  readonly catalog: AdapterCatalog;
  readonly schemaValidator?: SchemaValidator;
  readonly now?: () => string;
}

const DYNAMIC_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function disabled(): Response {
  return problemResponse({
    type: "urn:gauntlet:problem:adapter-disabled",
    title: "Adapter disabled",
    status: 503,
  });
}

function invalidPath(): Response {
  return problemResponse(problem("urn:gauntlet:problem:invalid-path", "Invalid path", 400));
}

function invalidLastEventId(): Response {
  return problemResponse({
    type: "urn:gauntlet:problem:validation-failed",
    title: "Validation failed",
    status: 422,
    errors: [{
      instancePath: "/headers/Last-Event-ID",
      schemaPath: "#/$defs/portableId/pattern",
      keyword: "pattern",
      message: "value does not satisfy schema",
      params: {},
    }],
  });
}

function routeNotFound(): Response {
  return problemResponse(problem("urn:gauntlet:problem:route-not-found", "Route not found", 404));
}

function methodNotAllowed(): Response {
  return problemResponse(problem("urn:gauntlet:problem:method-not-allowed", "Method not allowed", 405));
}

function notFound(kind: "operation" | "run" | "data source"): Response {
  const slug = kind === "data source" ? "data-source" : kind;
  return problemResponse(problem(
    `urn:gauntlet:problem:${slug}-not-found`,
    `${kind[0]!.toUpperCase()}${kind.slice(1)} not found`,
    404,
  ));
}

function revisionHeaders(value: { readonly revision?: string; readonly manifestRevision?: string }): Headers {
  return new Headers({ etag: `"${value.revision ?? value.manifestRevision}"` });
}

function notModified(request: Request, headers: Headers): Response | undefined {
  return request.headers.get("if-none-match") === headers.get("etag")
    ? new Response(null, { status: 304, headers })
    : undefined;
}

function unavailableCapability(catalog: AdapterCatalog, id: CoreCapabilityId): Response | undefined {
  const availability = catalog.capabilityAvailability(id);
  return availability.supported
    ? undefined
    : catalogProblemResponse(availability.problem, id);
}

function createdStatus(run: Run): 201 | 202 {
  return run.state === "queued" || run.state === "running" ? 202 : 201;
}

function hasInvalidKnownRouteShape(target: string): boolean {
  const parts = target.slice("/_gauntlet/v1/".length).split("/");
  const root = parts[0];
  if (root === "health" || root === "manifest" || root === "uploads") {
    return parts.length !== 1;
  }
  if (root === "operations") {
    return parts.length < 2
      || !DYNAMIC_SEGMENT.test(parts[1]!)
      || (parts.length === 3 ? parts[2] !== "runs" : parts.length !== 2);
  }
  if (root === "data-sources") {
    return parts.length !== 3
      || !DYNAMIC_SEGMENT.test(parts[1]!)
      || (parts[2] !== "query" && parts[2] !== "resolve");
  }
  if (root === "runs") {
    if (parts.length < 2 || !DYNAMIC_SEGMENT.test(parts[1]!)) return true;
    if (parts.length === 2) return false;
    if (parts.length === 3) return parts[2] !== "cancel" && parts[2] !== "events";
    return parts.length !== 5
      || parts[2] !== "artifacts"
      || !DYNAMIC_SEGMENT.test(parts[3]!)
      || parts[4] !== "launch";
  }
  return false;
}

function hasUnsafeRawSyntax(target: string): boolean {
  return target.includes("?")
    || target.includes("#")
    || target.includes("%")
    || /[\\\s]/.test(target)
    || target.includes("//")
    || target.includes("/./")
    || target.includes("/../")
    || target.endsWith("/.")
    || target.endsWith("/..")
    || target.endsWith("/");
}

function normalizedPointer(value: string, fallback: "" | "#"): string {
  if (value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) return fallback;
  if (fallback === "") return value === "" || value.startsWith("/") ? value : fallback;
  return value === "#" || value.startsWith("#/") ? value : fallback;
}

function sanitizedCatalogProblem(value: Problem, expectedCapability?: CoreCapabilityId): Problem {
  const owned = ownCanonicalProblem(value);
  const simple = (title: string, status: number): Problem => {
    if (owned.status !== status) throw new TypeError("Catalog Problem status is invalid");
    return { type: owned.type, title, status };
  };

  let sanitized: Problem;
  switch (owned.type) {
    case "urn:gauntlet:problem:adapter-disabled":
      sanitized = simple("Adapter disabled", 503);
      break;
    case "urn:gauntlet:problem:unsupported-capability": {
      if (owned.status !== 501 || expectedCapability === undefined) {
        throw new TypeError("Catalog capability Problem is invalid");
      }
      sanitized = {
        type: owned.type,
        title: "Unsupported capability",
        status: 501,
        capability: expectedCapability,
      };
      break;
    }
    case "urn:gauntlet:problem:operation-not-found":
      sanitized = simple("Operation not found", 404);
      break;
    case "urn:gauntlet:problem:operation-busy":
      sanitized = simple("Operation busy", 409);
      break;
    case "urn:gauntlet:problem:run-not-found":
      sanitized = simple("Run not found", 404);
      break;
    case "urn:gauntlet:problem:run-not-cancellable":
      sanitized = simple("Run is not cancellable", 409);
      break;
    case "urn:gauntlet:problem:run-cancelled":
      sanitized = simple("Run cancelled", 409);
      break;
    case "urn:gauntlet:problem:run-timed-out":
      sanitized = simple("Run timed out", 504);
      break;
    case "urn:gauntlet:problem:data-source-not-found":
      sanitized = simple("Data source not found", 404);
      break;
    case "urn:gauntlet:problem:route-not-found":
      sanitized = simple("Route not found", 404);
      break;
    case "urn:gauntlet:problem:method-not-allowed":
      sanitized = simple("Method not allowed", 405);
      break;
    case "urn:gauntlet:problem:invalid-json":
      sanitized = simple("Invalid JSON", 400);
      break;
    case "urn:gauntlet:problem:invalid-path":
      sanitized = simple("Invalid path", 400);
      break;
    case "urn:gauntlet:problem:validation-failed": {
      if (owned.status !== 422) throw new TypeError("Catalog validation Problem is invalid");
      sanitized = {
        type: owned.type,
        title: "Validation failed",
        status: 422,
        ...(owned.errors === undefined ? {} : {
          errors: owned.errors.slice(0, 100).map((error) => ({
            instancePath: normalizedPointer(error.instancePath, ""),
            schemaPath: normalizedPointer(error.schemaPath, "#"),
            keyword: /^[A-Za-z0-9._:-]{1,64}$/.test(error.keyword)
              ? error.keyword
              : "validation",
            message: "value does not satisfy schema",
            params: {},
          })),
        }),
      };
      break;
    }
    case "urn:gauntlet:problem:stale-operation-revision":
      sanitized = simple("Operation revision is stale", 409);
      break;
    case "urn:gauntlet:problem:handler-failed":
      sanitized = simple("Operation failed", 500);
      break;
    case "urn:gauntlet:problem:adapter-invalid-response":
      sanitized = simple("Invalid adapter response", 502);
      break;
    case "urn:gauntlet:problem:adapter-unavailable":
      sanitized = simple("Operation unavailable", 503);
      break;
    case "urn:gauntlet:problem:adapter-internal-error":
      sanitized = simple("Adapter internal error", 500);
      break;
    default:
      throw new TypeError("Catalog Problem type is not transport-safe");
  }
  return ownCanonicalProblem(sanitized);
}

function ownSafeCatalogManifest(value: AdapterManifest): AdapterManifest {
  const manifest = ownCanonicalAdapterManifest(value);
  for (const operation of manifest.operations) {
    if (operation.availability.state !== "unavailable") continue;
    const supplied = operation.availability.problem;
    const sanitized = sanitizedCatalogProblem(supplied);
    const keys = Object.keys(supplied);
    if (sanitized.type !== "urn:gauntlet:problem:adapter-unavailable"
      || supplied.title !== sanitized.title
      || supplied.status !== sanitized.status
      || keys.some((key) => !["type", "title", "status", "detail"].includes(key))
      || (supplied.detail !== undefined
        && supplied.detail !== "The operation requirements are not available in this adapter.")) {
      throw new TypeError("Manifest contains an unsafe availability Problem");
    }
  }
  return manifest;
}

function catalogProblemResponse(value: Problem, expectedCapability?: CoreCapabilityId): Response {
  try {
    return problemResponse(sanitizedCatalogProblem(value, expectedCapability));
  } catch {
    return internalError();
  }
}

function catalogProblem(error: unknown): Response | undefined {
  return error instanceof AdapterCatalogError ? catalogProblemResponse(error.problem) : undefined;
}

function eventStream(
  events: AsyncIterable<RunEvent>,
  validate: (event: RunEvent) => Promise<RunEvent>,
): Response {
  const iterator = events[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let previousRun: Run | undefined;
  let iteratorClosed = false;
  const closeIterator = async (): Promise<void> => {
    if (iteratorClosed) return;
    iteratorClosed = true;
    try {
      await iterator.return?.();
    } catch {
      // The public stream error is fixed and must not expose provider failures.
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          iteratorClosed = true;
          controller.close();
          return;
        }
        const event = await validate(next.value);
        if (previousRun !== undefined && validateRunTransition(previousRun, event.run) !== undefined) {
          throw new TypeError("Run event stream contains an invalid transition");
        }
        previousRun = event.run;
        controller.enqueue(encoder.encode(
          `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        ));
      } catch {
        await closeIterator();
        controller.error(new TypeError("Run event stream failed"));
      }
    },
    async cancel() {
      await closeIterator();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream; charset=utf-8",
    },
  });
}

function sessionIsSafe(value: SessionLaunchResponse, now: () => string): boolean {
  if (value.singleUse !== true) return false;
  const expiresAt = Date.parse(value.expiresAt);
  const current = Date.parse(now());
  if (!Number.isFinite(expiresAt)
    || !Number.isFinite(current)
    || expiresAt <= current
    || expiresAt - current > 15 * 60 * 1000) return false;
  try {
    const url = new URL(value.url);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

interface RunExpectation {
  readonly runId?: string;
  readonly operationId?: string;
}

function requirementsKey(requirements: ProtocolRequirements | undefined): string {
  return canonicalizeForRevision((requirements ?? {}) as JsonObject);
}

function ownCatalogOperation(
  catalog: AdapterCatalog,
  manifest: AdapterManifest,
  operationId: string,
): OperationDefinition | undefined {
  const supplied = catalog.operation(operationId);
  if (supplied === undefined) return undefined;
  const operation = ownCanonicalOperationDefinition(supplied);
  const summary = manifest.operations.find(({ id }) => id === operationId);
  if (operation.id !== operationId
    || summary === undefined
    || summary.revision !== operation.revision
    || summary.label !== operation.label
    || summary.featureId !== operation.featureId
    || requirementsKey(summary.requirements) !== requirementsKey(operation.requirements)) {
    throw new TypeError("Catalog operation does not match the manifest");
  }
  return operation;
}

async function ownCatalogRun(
  value: Run,
  catalog: AdapterCatalog,
  schemaValidator: SchemaValidator,
  expectation: RunExpectation,
): Promise<Run> {
  let run = ownCanonicalRun(value);
  if (run.state === "failed"
    || run.state === "partial"
    || run.state === "cancelled"
    || run.state === "timed_out"
    || run.state === "expired") {
    run = ownCanonicalRun({ ...run, problem: sanitizedCatalogProblem(run.problem) });
  }
  if (expectation.runId !== undefined && run.id !== expectation.runId) {
    throw new TypeError("Catalog Run ID does not match the requested resource");
  }

  const manifest: AdapterManifest = ownSafeCatalogManifest(catalog.manifest());
  const operation = ownCatalogOperation(catalog, manifest, run.operationId);
  if (operation === undefined) {
    throw new TypeError("Catalog Run references an unknown operation");
  }

  let outputIsValid = true;
  if (run.output !== undefined) {
    const validationErrors = await schemaValidator.validate(
      operation.output.schema,
      run.output as JsonValue,
    );
    if (!Array.isArray(validationErrors)) {
      throw new TypeError("Schema validator returned an invalid result");
    }
    outputIsValid = validationErrors.length === 0;
  }
  let requiresCatalogInputHandlingGuard = false;
  for (const action of run.actions) {
    if (action.kind !== "invoke-operation") continue;
    const target = ownCatalogOperation(catalog, manifest, action.operationId);
    if (target === undefined) {
      throw new TypeError("Catalog Run action references an unknown operation");
    }
    const actionErrors = await schemaValidator.validate(
      target.inputSchema,
      (action.input ?? {}) as JsonObject,
    );
    if (!Array.isArray(actionErrors)) {
      throw new TypeError("Schema validator returned an invalid result");
    }
    if (actionErrors.length > 0) {
      throw new TypeError("Catalog Run action input violates its target schema");
    }
    requiresCatalogInputHandlingGuard ||= (target.inputHandling?.rules.length ?? 0) > 0;
  }
  if (!runSemanticsAreValid(run, {
    ...(expectation.operationId === undefined
      ? { operationId: operation.id }
      : { operationId: expectation.operationId }),
    operationRevision: operation.revision,
    operationIds: manifest.operations.map(({ id }) => id),
    outputIsValid: () => outputIsValid,
  })) {
    throw new TypeError("Catalog Run violates protocol semantics");
  }
  if (catalog.runProjectionIsValid !== undefined) {
    const valid = await catalog.runProjectionIsValid(run, {
      ...(expectation.runId === undefined ? {} : { id: expectation.runId }),
      operationId: expectation.operationId ?? operation.id,
      operationRevision: operation.revision,
    });
    if (valid !== true) {
      throw new TypeError("Catalog Run failed its application input-handling guard");
    }
  } else if (requiresCatalogInputHandlingGuard) {
    throw new TypeError("Catalog cannot validate protected follow-up action inputs");
  }
  return run;
}

async function ownCatalogRunEvent(
  value: RunEvent,
  catalog: AdapterCatalog,
  schemaValidator: SchemaValidator,
  runId: string,
): Promise<RunEvent> {
  const event = ownCanonicalRunEvent(value);
  const run = await ownCatalogRun(event.run, catalog, schemaValidator, { runId });
  if (event.sequence !== run.sequence || event.occurredAt !== run.updatedAt) {
    throw new TypeError("Catalog Run event does not match its snapshot");
  }
  return ownCanonicalRunEvent({ ...event, run });
}

function internalError(): Response {
  return problemResponse({
    type: "urn:gauntlet:problem:adapter-internal-error",
    title: "Adapter internal error",
    status: 500,
    correlationId: crypto.randomUUID(),
  } as Problem);
}

export function createAdapterFetchHandler(options: AdapterFetchHandlerOptions): AdapterFetchHandler {
  if (options.enabled === true) ownSafeCatalogManifest(options.catalog.manifest());
  const now = options.now ?? (() => new Date().toISOString());
  const schemaValidator = options.schemaValidator ?? createAjvSchemaValidator();

  const dispatch: AdapterFetchHandler = async (boundary) => {
    const target = boundary.kind === "raw" ? boundary.rawTarget : boundary.normalizedTarget;
    if (!isAdapterTarget(target)) return routeNotFound();
    if (options.enabled !== true) return disabled();
    if ((boundary.kind === "raw" && !target.startsWith("/")) || hasUnsafeRawSyntax(target)) {
      return invalidPath();
    }

    const segments = parseAdapterPath(target);
    if (segments === undefined) {
      return hasInvalidKnownRouteShape(target) ? invalidPath() : routeNotFound();
    }
    const request = boundary.request;

    try {
      if (segments[0] === "health") {
        return request.method === "GET"
          ? jsonResponse(ownCanonicalAdapterHealth(options.catalog.health()))
          : methodNotAllowed();
      }
      if (segments[0] === "manifest") {
        if (request.method !== "GET") return methodNotAllowed();
        const value = ownSafeCatalogManifest(options.catalog.manifest());
        const headers = revisionHeaders(value);
        return notModified(request, headers) ?? jsonResponse(value, 200, headers);
      }
      if (segments[0] === "operations" && segments.length === 2) {
        if (request.method !== "GET") return methodNotAllowed();
        const manifest = ownSafeCatalogManifest(options.catalog.manifest());
        const value = ownCatalogOperation(options.catalog, manifest, segments[1]!);
        if (value === undefined) return notFound("operation");
        const headers = revisionHeaders(value);
        return notModified(request, headers) ?? jsonResponse(value, 200, headers);
      }
      if (segments[0] === "operations") {
        if (request.method !== "POST") return methodNotAllowed();
        const body = await readJsonObject(request);
        if (!body.ok) return problemResponse(body.problem);
        const result = await options.catalog.createRun(segments[1]!, body.value as never);
        if (!result.ok) return catalogProblemResponse(result.problem);
        const run = await ownCatalogRun(result.run, options.catalog, schemaValidator, {
          operationId: segments[1]!,
        });
        return jsonResponse(run, createdStatus(run));
      }
      if (segments[0] === "runs" && segments.length === 2) {
        if (request.method !== "GET") return methodNotAllowed();
        const supplied = await options.catalog.run(segments[1]!);
        if (supplied === undefined) return notFound("run");
        const run = await ownCatalogRun(supplied, options.catalog, schemaValidator, {
          runId: segments[1]!,
        });
        return jsonResponse(run);
      }
      if (segments[0] === "data-sources") {
        if (request.method !== "POST") return methodNotAllowed();
        const manifest = ownSafeCatalogManifest(options.catalog.manifest());
        if (!manifest.dataSources.some(({ id }) => id === segments[1])) {
          return notFound("data source");
        }
        const body = await readJsonObject(request);
        if (!body.ok) return problemResponse(body.problem);
        try {
          if (segments[2] === "query") {
            return jsonResponse(ownCanonicalDataSourcePage(
              await options.catalog.queryDataSource(segments[1]!, body.value as never),
            ));
          }
          const value = ownCanonicalDataSourceResolveResponse(
            await options.catalog.resolveDataSource(segments[1]!, body.value as never),
          );
          if (!resolveSemanticsAreValid(body.value as never, value)) {
            throw new TypeError("Catalog data source resolve response is invalid");
          }
          return jsonResponse(value);
        } catch (error) {
          const response = catalogProblem(error);
          if (response !== undefined) return response;
          throw error;
        }
      }
      if (segments[0] === "uploads") {
        if (request.method !== "POST") return methodNotAllowed();
        const unavailable = unavailableCapability(options.catalog, "tc-uploads@1");
        if (unavailable !== undefined) return unavailable;
        const multipart = await readMultipartFile(request);
        if (!multipart.ok) return problemResponse(multipart.problem);
        const result = await options.catalog.createUpload(multipart.file);
        return result.ok
          ? jsonResponse(ownCanonicalUploadResponse(result.value), 201)
          : catalogProblemResponse(result.problem, "tc-uploads@1");
      }
      if (segments[0] === "runs" && segments[2] === "cancel") {
        if (request.method !== "POST") return methodNotAllowed();
        const unavailable = unavailableCapability(options.catalog, "tc-run-cancellation@1");
        if (unavailable !== undefined) return unavailable;
        const result = await options.catalog.cancelRun(segments[1]!);
        if (!result.ok) {
          return catalogProblemResponse(result.problem, "tc-run-cancellation@1");
        }
        const run = await ownCatalogRun(result.value, options.catalog, schemaValidator, {
          runId: segments[1]!,
        });
        return jsonResponse(run, 202);
      }
      if (segments[0] === "runs" && segments[2] === "events") {
        if (request.method !== "GET") return methodNotAllowed();
        const unavailable = unavailableCapability(options.catalog, "tc-run-sse@1");
        if (unavailable !== undefined) return unavailable;
        const lastEventId = request.headers.get("last-event-id");
        if (lastEventId !== null && !isProtocolId(lastEventId)) {
          return invalidLastEventId();
        }
        const result = await options.catalog.runEvents(
          segments[1]!,
          lastEventId ?? undefined,
        );
        return result.ok
          ? eventStream(
              result.value,
              (event) => ownCatalogRunEvent(
                event,
                options.catalog,
                schemaValidator,
                segments[1]!,
              ),
            )
          : catalogProblemResponse(result.problem, "tc-run-sse@1");
      }
      if (segments[0] === "runs") {
        if (request.method !== "POST") return methodNotAllowed();
        const unavailable = unavailableCapability(options.catalog, "tc-session-launch@1");
        if (unavailable !== undefined) return unavailable;
        const result = await options.catalog.launchSession(segments[1]!, segments[3]!);
        if (!result.ok) {
          return catalogProblemResponse(result.problem, "tc-session-launch@1");
        }
        const value = ownCanonicalSessionLaunchResponse(result.value);
        return sessionIsSafe(value, now) ? jsonResponse(value, 201) : internalError();
      }
      return routeNotFound();
    } catch {
      return internalError();
    }
  };

  return async (boundary) => {
    const response = await dispatch(boundary);
    return boundary.request.method === "HEAD"
      ? new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers),
        })
      : response;
  };
}
