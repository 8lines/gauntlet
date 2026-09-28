import {
  assertRuntimeJsonData,
  isProtocolId,
  manifestSemanticsAreValid,
  operationSemanticsAreValid,
  resolveSemanticsAreValid,
  runSemanticsAreValid,
  type AdapterHealth,
  type AdapterManifest,
  type CapabilityId,
  type CreateRunRequest,
  type DataSourcePage,
  type DataSourceQuery,
  type DataSourceResolveRequest,
  type DataSourceResolveResponse,
  type OperationDefinition,
  type Problem,
  type Run,
  type SessionLaunchResponse,
  type UploadResponse,
} from "@8lines/gauntlet-protocol";
import type { ValidateFunction } from "ajv";
import { ownCanonicalJson } from "./json-ownership.js";
import {
  protocolValidators,
  validates,
} from "./protocol-validator.js";
import {
  adapterUnavailableProblem,
  incompatibleProtocolProblem,
  invalidPathProblem,
  invalidResponseProblem,
  payloadTooLargeProblem,
  requestValidationProblem,
} from "./problems.js";
import {
  createAdapterRunEventStream,
  type AdapterRunEventStream,
} from "./run-event-stream.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

type Fetch = typeof globalThis.fetch;

export interface AdapterTarget {
  readonly id: string;
  readonly adapterUrl: string;
}

export type ClientFailureKind = "protocol-major-mismatch";

export type ClientResult<T> =
  | { readonly ok: true; readonly value: T; readonly etag?: string }
  | { readonly ok: false; readonly problem: Problem; readonly failureKind?: ClientFailureKind };

export type ManifestFetchResult =
  | { readonly notModified: true }
  | { readonly notModified: false; readonly manifest: AdapterManifest };

export interface AdapterClient {
  health(target: AdapterTarget): Promise<ClientResult<AdapterHealth>>;
  getManifest(target: AdapterTarget, etag?: string): Promise<ClientResult<ManifestFetchResult>>;
  getOperation(target: AdapterTarget, operationId: string): Promise<ClientResult<OperationDefinition>>;
  createRun(target: AdapterTarget, operationId: string, request: CreateRunRequest): Promise<ClientResult<Run>>;
  getRun(target: AdapterTarget, runId: string): Promise<ClientResult<Run>>;
  queryDataSource(target: AdapterTarget, dataSourceId: string, request: DataSourceQuery): Promise<ClientResult<DataSourcePage>>;
  resolveDataSource(target: AdapterTarget, dataSourceId: string, request: DataSourceResolveRequest): Promise<ClientResult<DataSourceResolveResponse>>;
  createUpload(target: AdapterTarget, file: Blob, fileName?: string): Promise<ClientResult<UploadResponse>>;
  cancelRun(target: AdapterTarget, runId: string): Promise<ClientResult<Run>>;
  streamRunEvents(target: AdapterTarget, runId: string, lastEventId?: string): Promise<ClientResult<AdapterRunEventStream>>;
  createSessionLaunch(target: AdapterTarget, runId: string, artifactId: string): Promise<ClientResult<SessionLaunchResponse>>;
}

export interface AdapterClientOptions {
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxUploadBytes?: number;
}

interface ResponseSpec<T, R = never> {
  readonly statuses: ReadonlySet<number>;
  readonly validator: ValidateFunction<T>;
  readonly semantics?: (value: T, status: number, request: R | undefined) => boolean;
  readonly revision?: (value: T) => string;
  readonly detectProtocolMajorMismatch?: boolean;
  readonly expectedCapability?: CapabilityId;
}

type PostRequest<R> =
  | { readonly method: "POST" }
  | { readonly method: "POST"; readonly document: unknown; readonly validator: ValidateFunction<R> }
  | { readonly method: "POST"; readonly ownedDocument: R };

class InvalidResponseError extends Error {}
class ResponseTransportError extends Error {}

function fail<T>(problem: Problem, failureKind?: ClientFailureKind): ClientResult<T> {
  return {
    ok: false,
    problem,
    ...(failureKind === undefined ? {} : { failureKind }),
  };
}

function validateRequestDocument<T>(value: unknown, validator: ValidateFunction<T>): ClientResult<T> {
  try {
    const owned = ownCanonicalJson(value);
    return validates(validator, owned)
      ? { ok: true, value: owned }
      : fail(requestValidationProblem());
  } catch {
    return fail(requestValidationProblem());
  }
}

export function validateCreateRunRequest(value: unknown): ClientResult<CreateRunRequest> {
  return validateRequestDocument(value, protocolValidators.createRunRequest);
}

function hasProtocolMajorMismatch(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!Object.hasOwn(value, "protocolVersion")) return false;
  const protocolVersion = (value as Record<string, unknown>).protocolVersion;
  if (typeof protocolVersion !== "string") return false;
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(protocolVersion);
  return match !== null && match[1] !== "1";
}

function protocolMajorMismatch<T>(): ClientResult<T> {
  return fail(incompatibleProtocolProblem(), "protocol-major-mismatch");
}

function mediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function baseOrigin(target: AdapterTarget): string | undefined {
  if (!isProtocolId(target.id) || typeof target.adapterUrl !== "string") {
    return undefined;
  }
  try {
    const url = new URL(target.adapterUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.username !== ""
      || url.password !== ""
      || url.pathname !== "/"
      || url.search !== ""
      || url.hash !== "") {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function validEntityTag(value: string): boolean {
  return /^(?:W\/)?"[\x21\x23-\x7e]*"$/.test(value);
}

function validUploadName(value: string): boolean {
  return value.length > 0
    && new TextEncoder().encode(value).byteLength <= 255
    && !/[\x00-\x1f\x7f/\\]/.test(value);
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; cancellation is best-effort cleanup.
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await cancelBody(response);
    throw new InvalidResponseError();
  }
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch {
        throw new ResponseTransportError();
      }
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size violation remains the canonical failure.
        }
        throw new InvalidResponseError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidResponseError();
  }
}

async function jsonBody(response: Response, maxBytes: number): Promise<unknown> {
  const text = await readBounded(response, maxBytes);
  try {
    const value = JSON.parse(text) as unknown;
    assertRuntimeJsonData(value);
    return value;
  } catch {
    throw new InvalidResponseError();
  }
}

function responseEtag<T>(response: Response, value: T, revision?: (value: T) => string): string | undefined {
  const etag = response.headers.get("etag") ?? undefined;
  if (etag === undefined) {
    return undefined;
  }
  if (!validEntityTag(etag) || revision === undefined || etag !== `"${revision(value)}"`) {
    throw new InvalidResponseError();
  }
  return etag;
}

function requestHeaders(hasBody: boolean, etag?: string): Headers {
  const headers = new Headers({ accept: "application/json, application/problem+json" });
  if (hasBody) {
    headers.set("content-type", "application/json");
  }
  if (etag !== undefined) {
    headers.set("if-none-match", etag);
  }
  return headers;
}

function endpointProblemIsValid(
  problem: Problem,
  status: number,
  expectedCapability: CapabilityId | undefined,
): boolean {
  if (expectedCapability === undefined) return true;
  if (status !== 501 && problem.type !== "urn:gauntlet:problem:unsupported-capability") return true;
  return status === 501
    && problem.type === "urn:gauntlet:problem:unsupported-capability"
    && problem.capability === expectedCapability;
}

export function createAdapterClient(options: AdapterClientOptions = {}): AdapterClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError("maxResponseBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) {
    throw new TypeError("maxUploadBytes must be a positive safe integer");
  }

  const perform = async <T, R = never>(
    target: AdapterTarget,
    pathIds: readonly string[],
    path: () => string,
    spec: ResponseSpec<T, R>,
    request?: PostRequest<R>,
    etag?: string,
  ): Promise<ClientResult<T>> => {
    const origin = baseOrigin(target);
    if (origin === undefined || pathIds.some((id) => !isProtocolId(id)) || (etag !== undefined && !validEntityTag(etag))) {
      return fail(invalidPathProblem());
    }
    let ownedRequest: R | undefined;
    let body: string | undefined;
    if (request !== undefined && "ownedDocument" in request) {
      ownedRequest = request.ownedDocument;
      body = JSON.stringify(request.ownedDocument);
    } else if (request !== undefined && "validator" in request) {
      const validation = validateRequestDocument(request.document, request.validator);
      if (!validation.ok) {
        return validation;
      }
      ownedRequest = validation.value;
      body = JSON.stringify(validation.value);
    }

    let response: Response;
    try {
      response = await fetchImplementation(`${origin}${path()}`, {
        method: request?.method ?? "GET",
        headers: requestHeaders(body !== undefined, etag),
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return fail(adapterUnavailableProblem());
    }

    if (!(response instanceof Response)) {
      return fail(invalidResponseProblem());
    }
    try {
      if (!spec.statuses.has(response.status)) {
        if (response.status < 400 || response.status > 599 || mediaType(response) !== "application/problem+json") {
          await cancelBody(response);
          throw new InvalidResponseError();
        }
        const document = await jsonBody(response, maxResponseBytes);
        if (!validates(protocolValidators.problem, document)
          || document.status !== response.status
          || !endpointProblemIsValid(document, response.status, spec.expectedCapability)) {
          throw new InvalidResponseError();
        }
        return fail(document);
      }
      if (mediaType(response) !== "application/json") {
        await cancelBody(response);
        throw new InvalidResponseError();
      }
      const document = await jsonBody(response, maxResponseBytes);
      if (spec.detectProtocolMajorMismatch && hasProtocolMajorMismatch(document)) {
        return protocolMajorMismatch();
      }
      if (!validates(spec.validator, document)
        || spec.semantics?.(document, response.status, ownedRequest) === false) {
        throw new InvalidResponseError();
      }
      const responseTag = responseEtag(response, document, spec.revision);
      return {
        ok: true,
        value: document,
        ...(responseTag === undefined ? {} : { etag: responseTag }),
      };
    } catch (error) {
      return fail(error instanceof ResponseTransportError ? adapterUnavailableProblem() : invalidResponseProblem());
    }
  };

  const remoteProblem = async <T>(
    response: Response,
    expectedCapability?: CapabilityId,
  ): Promise<ClientResult<T>> => {
    try {
      if (response.status < 400
        || response.status > 599
        || mediaType(response) !== "application/problem+json") {
        await cancelBody(response);
        throw new InvalidResponseError();
      }
      const document = await jsonBody(response, maxResponseBytes);
      if (!validates(protocolValidators.problem, document)
        || document.status !== response.status
        || !endpointProblemIsValid(document, response.status, expectedCapability)) {
        throw new InvalidResponseError();
      }
      return fail(document);
    } catch (error) {
      return fail(error instanceof ResponseTransportError
        ? adapterUnavailableProblem()
        : invalidResponseProblem());
    }
  };

  return {
    async health(target) {
      return await perform(target, [], () => "/_gauntlet/v1/health", {
        statuses: new Set([200]),
        validator: protocolValidators.health,
        detectProtocolMajorMismatch: true,
      });
    },

    async getManifest(target, etag) {
      const origin = baseOrigin(target);
      if (origin === undefined || (etag !== undefined && !validEntityTag(etag))) {
        return fail(invalidPathProblem());
      }

      let response: Response;
      try {
        response = await fetchImplementation(`${origin}/_gauntlet/v1/manifest`, {
          method: "GET",
          headers: requestHeaders(false, etag),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return fail(adapterUnavailableProblem());
      }
      if (!(response instanceof Response)) {
        return fail(invalidResponseProblem());
      }
      if (response.status === 304) {
        const responseTag = response.headers.get("etag") ?? undefined;
        if (etag === undefined
          || response.body !== null
          || mediaType(response) !== ""
          || (responseTag !== undefined && (!validEntityTag(responseTag) || responseTag !== etag))) {
          await cancelBody(response);
          return fail(invalidResponseProblem());
        }
        return {
          ok: true,
          value: { notModified: true },
          ...(responseTag === undefined ? {} : { etag: responseTag }),
        };
      }

      const result = await performManifestResponse(response);
      return result;
    },

    async getOperation(target, operationId) {
      return await perform(target, [operationId], () => `/_gauntlet/v1/operations/${operationId}`, {
        statuses: new Set([200]),
        validator: protocolValidators.operation,
        semantics: (operation) => operation.id === operationId && operationSemanticsAreValid(operation),
        revision: (operation) => operation.revision,
      });
    },

    async createRun(target, operationId, request) {
      const validation = validateCreateRunRequest(request);
      if (!validation.ok) {
        return validation;
      }
      return await perform<Run, CreateRunRequest>(target, [operationId], () => `/_gauntlet/v1/operations/${operationId}/runs`, {
        statuses: new Set([201, 202]),
        validator: protocolValidators.run,
        semantics: (run, status, ownedRequest) => ownedRequest !== undefined
          && runSemanticsAreValid(run)
          && run.operationId === operationId
          && run.operationRevision === ownedRequest.operationRevision
          && (status === 202 ? run.state === "queued" || run.state === "running" : run.state !== "queued" && run.state !== "running"),
      }, { method: "POST", ownedDocument: validation.value });
    },

    async getRun(target, runId) {
      return await perform(target, [runId], () => `/_gauntlet/v1/runs/${runId}`, {
        statuses: new Set([200]),
        validator: protocolValidators.run,
        semantics: (run) => run.id === runId && runSemanticsAreValid(run),
      });
    },

    async queryDataSource(target, dataSourceId, request) {
      return await perform<DataSourcePage, DataSourceQuery>(target, [dataSourceId], () => `/_gauntlet/v1/data-sources/${dataSourceId}/query`, {
        statuses: new Set([200]),
        validator: protocolValidators.dataSourcePage,
      }, { method: "POST", document: request, validator: protocolValidators.dataSourceQuery });
    },

    async resolveDataSource(target, dataSourceId, request) {
      return await perform<DataSourceResolveResponse, DataSourceResolveRequest>(target, [dataSourceId], () => `/_gauntlet/v1/data-sources/${dataSourceId}/resolve`, {
        statuses: new Set([200]),
        validator: protocolValidators.dataSourceResolveResponse,
        semantics: (response, _status, ownedRequest) => ownedRequest !== undefined
          && resolveSemanticsAreValid(ownedRequest, response),
      }, { method: "POST", document: request, validator: protocolValidators.dataSourceResolveRequest });
    },

    async createUpload(target, file, fileName = "upload") {
      const origin = baseOrigin(target);
      try {
        if (origin === undefined
          || typeof Blob === "undefined"
          || !(file instanceof Blob)
          || !validUploadName(fileName)) {
          return fail(origin === undefined ? invalidPathProblem() : requestValidationProblem());
        }
        if (file.size > maxUploadBytes) {
          return fail(payloadTooLargeProblem());
        }
      } catch {
        return fail(requestValidationProblem());
      }

      const form = new FormData();
      form.append("file", file, fileName);
      let response: Response;
      try {
        response = await fetchImplementation(`${origin}/_gauntlet/v1/uploads`, {
          method: "POST",
          headers: new Headers({ accept: "application/json, application/problem+json" }),
          body: form,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return fail(adapterUnavailableProblem());
      }
      if (!(response instanceof Response)) return fail(invalidResponseProblem());
      if (response.status !== 201) return await remoteProblem(response, "tc-uploads@1");
      try {
        if (mediaType(response) !== "application/json") {
          await cancelBody(response);
          throw new InvalidResponseError();
        }
        const document = await jsonBody(response, maxResponseBytes);
        if (!validates(protocolValidators.upload, document)
          || document.file.sizeBytes !== file.size) {
          throw new InvalidResponseError();
        }
        return { ok: true, value: document };
      } catch (error) {
        return fail(error instanceof ResponseTransportError
          ? adapterUnavailableProblem()
          : invalidResponseProblem());
      }
    },

    async cancelRun(target, runId) {
      return await perform(target, [runId], () => `/_gauntlet/v1/runs/${runId}/cancel`, {
        statuses: new Set([202]),
        validator: protocolValidators.run,
        semantics: (run) => run.id === runId && runSemanticsAreValid(run),
        expectedCapability: "tc-run-cancellation@1",
      }, { method: "POST" });
    },

    async streamRunEvents(target, runId, lastEventId) {
      const origin = baseOrigin(target);
      if (origin === undefined
        || !isProtocolId(runId)
        || (lastEventId !== undefined && !isProtocolId(lastEventId))) {
        return fail(invalidPathProblem());
      }
      const headers = new Headers({ accept: "text/event-stream, application/problem+json" });
      if (lastEventId !== undefined) headers.set("last-event-id", lastEventId);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImplementation(`${origin}/_gauntlet/v1/runs/${runId}/events`, {
          method: "GET",
          headers,
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        clearTimeout(timer);
        return fail(adapterUnavailableProblem());
      }
      if (!(response instanceof Response)) {
        clearTimeout(timer);
        return fail(invalidResponseProblem());
      }
      if (response.status !== 200) {
        try {
          return await remoteProblem(response, "tc-run-sse@1");
        } finally {
          clearTimeout(timer);
        }
      }
      if (mediaType(response) !== "text/event-stream" || response.body === null) {
        await cancelBody(response);
        clearTimeout(timer);
        return fail(invalidResponseProblem());
      }
      clearTimeout(timer);
      try {
        return {
          ok: true,
          value: createAdapterRunEventStream(
            response,
            runId,
            maxResponseBytes,
            () => controller.abort(),
          ),
        };
      } catch {
        await cancelBody(response);
        return fail(invalidResponseProblem());
      }
    },

    async createSessionLaunch(target, runId, artifactId) {
      return await perform(target, [runId, artifactId], () => `/_gauntlet/v1/runs/${runId}/artifacts/${artifactId}/launch`, {
        statuses: new Set([201]),
        validator: protocolValidators.sessionLaunch,
        expectedCapability: "tc-session-launch@1",
      }, { method: "POST" });
    },
  };

  async function performManifestResponse(response: Response): Promise<ClientResult<ManifestFetchResult>> {
    try {
      if (response.status !== 200) {
        if (response.status < 400 || response.status > 599 || mediaType(response) !== "application/problem+json") {
          await cancelBody(response);
          throw new InvalidResponseError();
        }
        const document = await jsonBody(response, maxResponseBytes);
        if (!validates(protocolValidators.problem, document) || document.status !== response.status) {
          throw new InvalidResponseError();
        }
        return fail(document);
      }
      if (mediaType(response) !== "application/json") {
        await cancelBody(response);
        throw new InvalidResponseError();
      }
      const document = await jsonBody(response, maxResponseBytes);
      if (hasProtocolMajorMismatch(document)) {
        return protocolMajorMismatch();
      }
      if (!validates(protocolValidators.manifest, document) || !manifestSemanticsAreValid(document)) {
        throw new InvalidResponseError();
      }
      const etag = responseEtag(response, document, (manifest) => manifest.manifestRevision);
      return {
        ok: true,
        value: { notModified: false, manifest: document },
        ...(etag === undefined ? {} : { etag }),
      };
    } catch (error) {
      return fail(error instanceof ResponseTransportError ? adapterUnavailableProblem() : invalidResponseProblem());
    }
  }
}
