import { isProtocolId, type CapabilityId, type JsonObject } from "@8lines/gauntlet-protocol";
import {
  assertCanonicalJson,
  assertEndpointDocument,
  type EndpointDocument,
  SchemaValidationError,
} from "./schema-validator.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const JSON_MEDIA = "application/json";
const PROBLEM_MEDIA = "application/problem+json";

type Fetch = typeof globalThis.fetch;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class ConformanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConformanceFailure";
  }
}

export interface SerializedJsonRequest {
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export interface AdapterV1HttpClientOptions {
  readonly baseUrl: string;
  readonly fetch?: Fetch;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly secretSentinels?: readonly string[];
}

interface JsonResult<T> {
  readonly status: number;
  readonly document: T;
  readonly etag?: string;
}

export type ConditionalJsonResult<T> =
  | { readonly notModified: true; readonly etag?: string }
  | { readonly notModified: false; readonly document: T; readonly etag: string };

function configuration(message: string): never {
  throw new ConfigurationError(message);
}

function integerOption(value: number, maximum: number, name: string): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    configuration(`Invalid ${name}`);
  }
}

function originOnly(value: string): string {
  if (typeof value !== "string" || value.trim() !== value) configuration("Invalid adapter base URL");
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.username !== ""
      || url.password !== ""
      || url.pathname !== "/"
      || url.search !== ""
      || url.hash !== "") {
      return configuration("Invalid adapter base URL");
    }
    return url.origin;
  } catch {
    return configuration("Invalid adapter base URL");
  }
}

function strongEntityTag(value: string): boolean {
  return /^"[\x21\x23-\x7e]*"$/.test(value);
}

function mediaType(headers: Headers): string {
  return headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function expected(statuses: readonly number[], type: string): string {
  return `${statuses.join(" or ")}/${type}`;
}

function failurePrefix(
  method: string,
  path: string,
  statuses: readonly number[],
  type: string,
  receivedStatus: number | "transport",
  receivedType: string,
): string {
  return `${method} ${path}: expected ${expected(statuses, type)}, received ${receivedStatus}/${receivedType}`;
}

function responseFailure(prefix: string, error: unknown): ConformanceFailure {
  if (error instanceof SchemaValidationError) return new ConformanceFailure(`${prefix}; ${error.message}`);
  if (error instanceof ConformanceFailure) {
    return error.message.startsWith(prefix)
      ? error
      : new ConformanceFailure(`${prefix}; ${error.message}`);
  }
  return new ConformanceFailure(`${prefix}; response validation failed`);
}

function safePathId(value: string): string {
  if (!isProtocolId(value)) configuration("Invalid protocol path ID");
  return value;
}

function requestHeaders(hasBody: boolean, etag?: string): Headers {
  const headers = new Headers({ accept: "application/json, application/problem+json" });
  if (hasBody) headers.set("content-type", JSON_MEDIA);
  if (etag !== undefined) headers.set("if-none-match", etag);
  return headers;
}

function containsSentinel(value: string, sentinels: readonly string[]): boolean {
  return sentinels.some((sentinel) => sentinel.length > 0 && value.includes(sentinel));
}

function parsedContainsSentinel(root: unknown, sentinels: readonly string[]): boolean {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (containsSentinel(value, sentinels)) return true;
      continue;
    }
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (containsSentinel(key, sentinels)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    const cancellation = response.body?.cancel();
    void cancellation?.catch(() => {});
  } catch {
    // Cancellation is best-effort after the canonical failure has been chosen.
  }
}

function abortPromise(signal: AbortSignal): { readonly promise: Promise<never>; close(): void } {
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new ConformanceFailure("Adapter response deadline expired"));
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
  });
  return {
    promise,
    close() {
      if (listener !== undefined) signal.removeEventListener("abort", listener);
    },
  };
}

async function readBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^[0-9]+$/.test(contentLength)
      || !Number.isSafeInteger(Number(contentLength))
      || Number(contentLength) > maxBytes) {
      await cancelResponse(response);
      throw new ConformanceFailure("Adapter response size is invalid");
    }
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  const aborted = abortPromise(signal);
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await Promise.race([reader.read(), aborted.promise]);
      } catch {
        throw new ConformanceFailure("Adapter response could not be read");
      }
      if (next.done) {
        complete = true;
        break;
      }
      size += next.value.byteLength;
      if (size > maxBytes) throw new ConformanceFailure("Adapter response size is invalid");
      chunks.push(next.value);
    }
  } finally {
    aborted.close();
    let cancellation: Promise<void> | undefined;
    if (!complete) {
      try {
        cancellation = reader.cancel();
        void cancellation.catch(() => {});
      } catch {
        // The bounded-read failure remains canonical.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      const releaseAfterCancellation = (): void => {
        try {
          reader.releaseLock();
        } catch {
          // A hostile stream cannot replace the bounded-read failure.
        }
      };
      void cancellation?.then(releaseAfterCancellation, releaseAfterCancellation);
    }
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
    throw new ConformanceFailure("Adapter response encoding is invalid");
  }
}

export function serializeJsonRequest<T = unknown>(
  endpoint: EndpointDocument,
  value: unknown,
  afterValidation?: (document: T) => void,
): SerializedJsonRequest {
  let document: T;
  try {
    assertCanonicalJson(value, "Request is not canonical JSON");
    document = assertEndpointDocument<T>(endpoint, value);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("Invalid JSON request document");
  }
  afterValidation?.(document);
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  if (bytes.byteLength > MAX_BODY_BYTES) configuration("JSON request is too large");
  return { bytes };
}

export class AdapterV1HttpClient {
  readonly #origin: string;
  readonly #fetch: Fetch;
  readonly #requestTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #secretSentinels: readonly string[];

  constructor(options: AdapterV1HttpClientOptions) {
    this.#origin = originOnly(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") configuration("Invalid Fetch implementation");
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    integerOption(this.#requestTimeoutMs, MAX_TIMEOUT_MS, "request timeout");
    integerOption(this.#maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "response byte limit");
    this.#secretSentinels = [...(options.secretSentinels ?? [])].filter((value) => value.length > 0);
  }

  async #fetchResponse(
    method: "GET" | "POST",
    path: string,
    statuses: readonly number[],
    expectedType: string,
    body?: SerializedJsonRequest,
    etag?: string,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<{ readonly response: Response; readonly signal: AbortSignal; readonly prefix: string }> {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}${path}`, {
        method,
        headers: requestHeaders(body !== undefined, etag),
        ...(body === undefined ? {} : { body: body.bytes }),
        redirect: "error",
        signal,
      });
    } catch {
      throw new ConformanceFailure(failurePrefix(method, path, statuses, expectedType, "transport", "error"));
    }
    if (!(response instanceof Response)) {
      throw new ConformanceFailure(failurePrefix(method, path, statuses, expectedType, "transport", "non-response"));
    }
    const prefix = failurePrefix(
      method,
      path,
      statuses,
      expectedType,
      response.status,
      mediaType(response.headers) || "none",
    );
    for (const [name, value] of response.headers) {
      if (containsSentinel(name, this.#secretSentinels) || containsSentinel(value, this.#secretSentinels)) {
        await cancelResponse(response);
        throw new ConformanceFailure(`${prefix}; Adapter response exposed a protected secret`);
      }
    }
    return {
      response,
      signal,
      prefix,
    };
  }

  async #parseJson(response: Response, signal: AbortSignal): Promise<unknown> {
    const text = await readBounded(response, this.#maxResponseBytes, signal);
    if (containsSentinel(text, this.#secretSentinels)) {
      throw new ConformanceFailure("Adapter response exposed a protected secret");
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new ConformanceFailure("Adapter response JSON is invalid");
    }
    assertCanonicalJson(value);
    if (parsedContainsSentinel(value, this.#secretSentinels)) {
      throw new ConformanceFailure("Adapter response exposed a protected secret");
    }
    return value;
  }

  async #validateUnexpectedProblem(response: Response, signal: AbortSignal): Promise<void> {
    if (response.status < 400 || response.status > 599 || mediaType(response.headers) !== PROBLEM_MEDIA) {
      await cancelResponse(response);
      return;
    }
    const value = await this.#parseJson(response, signal);
    const problem = assertEndpointDocument<Record<string, unknown>>("problem", value);
    if (problem.status !== response.status) throw new ConformanceFailure("Problem status does not match HTTP status");
  }

  async #json<T>(
    method: "GET" | "POST",
    path: string,
    statuses: readonly number[],
    body: SerializedJsonRequest | undefined,
    validate: (value: unknown) => T,
    timeoutMs?: number,
  ): Promise<JsonResult<T>> {
    const { response, signal, prefix } = await this.#fetchResponse(
      method,
      path,
      statuses,
      JSON_MEDIA,
      body,
      undefined,
      timeoutMs,
    );
    if (!statuses.includes(response.status) || mediaType(response.headers) !== JSON_MEDIA) {
      try {
        await this.#validateUnexpectedProblem(response, signal);
      } catch (error) {
        if (error instanceof ConformanceFailure && error.message === "Problem status does not match HTTP status") {
          throw new ConformanceFailure(`${prefix}; invalid Problem status`);
        }
        throw responseFailure(prefix, error);
      }
      throw new ConformanceFailure(prefix);
    }

    try {
      const document = validate(await this.#parseJson(response, signal));
      return { status: response.status, document };
    } catch (error) {
      throw responseFailure(prefix, error);
    }
  }

  async #revisionJson<T>(
    path: string,
    validate: (value: unknown) => T,
    revision: (value: T) => string,
    etag?: string,
  ): Promise<ConditionalJsonResult<T>> {
    if (etag !== undefined && !strongEntityTag(etag)) configuration("Invalid conditional ETag");
    const expectedStatus = etag === undefined ? [200] as const : [304] as const;
    const expectedType = etag === undefined ? JSON_MEDIA : "none";
    const { response, signal, prefix } = await this.#fetchResponse(
      "GET",
      path,
      expectedStatus,
      expectedType,
      undefined,
      etag,
    );

    if (etag !== undefined && response.status === 304) {
      const returnedTag = response.headers.get("etag");
      const length = response.headers.get("content-length");
      if (mediaType(response.headers) !== ""
        || response.body !== null
        || (length !== null && (!/^[0-9]+$/.test(length) || Number(length) !== 0))
        || response.headers.has("transfer-encoding")
        || (returnedTag !== null && returnedTag !== etag)) {
        await cancelResponse(response);
        throw new ConformanceFailure(prefix);
      }
      return { notModified: true, ...(returnedTag === null ? {} : { etag: returnedTag }) };
    }

    if (response.status !== 200 || mediaType(response.headers) !== JSON_MEDIA) {
      try {
        await this.#validateUnexpectedProblem(response, signal);
      } catch (error) {
        throw responseFailure(prefix, error);
      }
      throw new ConformanceFailure(prefix);
    }
    try {
      const document = validate(await this.#parseJson(response, signal));
      const responseTag = response.headers.get("etag");
      const requiredTag = `"${revision(document)}"`;
      if (responseTag === null || !strongEntityTag(responseTag) || responseTag !== requiredTag) {
        throw new ConformanceFailure(`${prefix}; invalid revision ETag`);
      }
      return { notModified: false, document, etag: responseTag };
    } catch (error) {
      throw responseFailure(prefix, error);
    }
  }

  async #problem(
    method: "GET" | "POST",
    path: string,
    status: number,
    type: string,
    capability?: CapabilityId,
    body?: SerializedJsonRequest,
  ): Promise<JsonObject> {
    const { response, signal, prefix } = await this.#fetchResponse(
      method,
      path,
      [status],
      PROBLEM_MEDIA,
      body,
    );
    if (response.status !== status || mediaType(response.headers) !== PROBLEM_MEDIA) {
      try {
        await this.#validateUnexpectedProblem(response, signal);
      } catch (error) {
        throw responseFailure(prefix, error);
      }
      throw new ConformanceFailure(prefix);
    }
    try {
      const problem = assertEndpointDocument<Record<string, unknown>>(
        "problem",
        await this.#parseJson(response, signal),
      );
      if (problem.status !== response.status || problem.type !== type || (capability !== undefined && problem.capability !== capability)) {
        throw new ConformanceFailure(`${prefix}; Problem fields do not match`);
      }
      return problem as JsonObject;
    } catch (error) {
      throw responseFailure(prefix, error);
    }
  }

  async #oneOfProblems(
    method: "GET" | "POST",
    path: string,
    alternatives: ReadonlyArray<{ readonly status: number; readonly type: string }>,
    body?: SerializedJsonRequest,
  ): Promise<JsonObject> {
    const statuses = alternatives.map(({ status }) => status);
    const types = alternatives.map(({ type }) => type).join(" or ");
    const { response, signal, prefix } = await this.#fetchResponse(
      method,
      path,
      statuses,
      types,
      body,
    );
    if (!statuses.includes(response.status) || mediaType(response.headers) !== PROBLEM_MEDIA) {
      try {
        await this.#validateUnexpectedProblem(response, signal);
      } catch (error) {
        throw responseFailure(prefix, error);
      }
      throw new ConformanceFailure(prefix);
    }
    try {
      const problem = assertEndpointDocument<Record<string, unknown>>(
        "problem",
        await this.#parseJson(response, signal),
      );
      const matches = alternatives.some(({ status, type }) =>
        response.status === status && problem.status === status && problem.type === type);
      if (!matches) throw new ConformanceFailure(`${prefix}; Problem fields do not match`);
      return problem as JsonObject;
    } catch (error) {
      throw responseFailure(prefix, error);
    }
  }

  async getHealth<T>(validate: (value: unknown) => T): Promise<T> {
    return (await this.#json("GET", "/_gauntlet/v1/health", [200], undefined, validate)).document;
  }

  async getManifest<T>(
    validate: (value: unknown) => T,
    etag?: string,
  ): Promise<ConditionalJsonResult<T>> {
    return await this.#revisionJson(
      "/_gauntlet/v1/manifest",
      validate,
      (value) => (value as { readonly manifestRevision: string }).manifestRevision,
      etag,
    );
  }

  async getOperation<T>(
    operationId: string,
    validate: (value: unknown) => T,
    etag?: string,
  ): Promise<ConditionalJsonResult<T>> {
    const path = `/_gauntlet/v1/operations/${safePathId(operationId)}`;
    return await this.#revisionJson(
      path,
      validate,
      (value) => (value as { readonly revision: string }).revision,
      etag,
    );
  }

  async createRun<T>(
    operationId: string,
    body: SerializedJsonRequest,
    validate: (value: unknown) => T,
  ): Promise<JsonResult<T>> {
    return await this.#json(
      "POST",
      `/_gauntlet/v1/operations/${safePathId(operationId)}/runs`,
      [201, 202],
      body,
      validate,
    );
  }

  async getRun<T>(runId: string, validate: (value: unknown) => T = (value) => value as T, timeoutMs?: number): Promise<T> {
    return (await this.#json(
      "GET",
      `/_gauntlet/v1/runs/${safePathId(runId)}`,
      [200],
      undefined,
      validate,
      timeoutMs,
    )).document;
  }

  async queryDataSource<T>(
    dataSourceId: string,
    body: SerializedJsonRequest,
    validate: (value: unknown) => T,
  ): Promise<T> {
    return (await this.#json(
      "POST",
      `/_gauntlet/v1/data-sources/${safePathId(dataSourceId)}/query`,
      [200],
      body,
      validate,
    )).document;
  }

  async resolveDataSource<T>(
    dataSourceId: string,
    body: SerializedJsonRequest,
    validate: (value: unknown) => T,
  ): Promise<T> {
    return (await this.#json(
      "POST",
      `/_gauntlet/v1/data-sources/${safePathId(dataSourceId)}/resolve`,
      [200],
      body,
      validate,
    )).document;
  }

  async launchSession<T>(runId: string, artifactId: string, validate: (value: unknown) => T): Promise<T> {
    return (await this.#json(
      "POST",
      `/_gauntlet/v1/runs/${safePathId(runId)}/artifacts/${safePathId(artifactId)}/launch`,
      [201],
      undefined,
      validate,
    )).document;
  }

  async expectCreateProblem(
    operationId: string,
    body: SerializedJsonRequest,
    status: number,
    type: string,
  ): Promise<JsonObject> {
    return await this.#problem(
      "POST",
      `/_gauntlet/v1/operations/${safePathId(operationId)}/runs`,
      status,
      type,
      undefined,
      body,
    );
  }

  async expectOperationProblem(operationId: string, status: number, type: string): Promise<JsonObject> {
    return await this.#problem("GET", `/_gauntlet/v1/operations/${safePathId(operationId)}`, status, type);
  }

  async expectDataSourceProblem(
    dataSourceId: string,
    body: SerializedJsonRequest,
    status: number,
    type: string,
  ): Promise<JsonObject> {
    return await this.#problem(
      "POST",
      `/_gauntlet/v1/data-sources/${safePathId(dataSourceId)}/query`,
      status,
      type,
      undefined,
      body,
    );
  }

  async expectRunProblem(runId: string, status: number, type: string): Promise<JsonObject> {
    return await this.#problem("GET", `/_gauntlet/v1/runs/${safePathId(runId)}`, status, type);
  }

  async expectUnsafeOperationProblem(): Promise<JsonObject> {
    return await this.#problem(
      "GET",
      "/_gauntlet/v1/operations/unsafe!id",
      400,
      "urn:gauntlet:problem:invalid-path",
    );
  }

  async expectCancelProblem(runId: string, status: number, type: string, capability: CapabilityId): Promise<JsonObject> {
    return await this.#problem(
      "POST",
      `/_gauntlet/v1/runs/${safePathId(runId)}/cancel`,
      status,
      type,
      capability,
    );
  }

  async expectEventsProblem(runId: string, status: number, type: string, capability: CapabilityId): Promise<JsonObject> {
    return await this.#problem(
      "GET",
      `/_gauntlet/v1/runs/${safePathId(runId)}/events`,
      status,
      type,
      capability,
    );
  }

  async expectUploadsProblem(status: number, type: string, capability: CapabilityId): Promise<JsonObject> {
    return await this.#problem("POST", "/_gauntlet/v1/uploads", status, type, capability);
  }

  async expectLaunchProblem(
    runId: string,
    artifactId: string,
    status: number,
    type: string,
    capability: CapabilityId,
  ): Promise<JsonObject> {
    return await this.#problem(
      "POST",
      `/_gauntlet/v1/runs/${safePathId(runId)}/artifacts/${safePathId(artifactId)}/launch`,
      status,
      type,
      capability,
    );
  }

  async expectAdapterDisabledPrecedence(operationId: string): Promise<void> {
    const type = "urn:gauntlet:problem:adapter-disabled";
    const malformed: SerializedJsonRequest = {
      bytes: new TextEncoder().encode("{not-json"),
    };
    await this.#problem("GET", "/_gauntlet/v1/health", 503, type);
    await this.#problem("GET", "/_gauntlet/v1/manifest", 503, type);
    await this.#oneOfProblems(
      "POST",
      "/_gauntlet/v1/operations/unsafe%21id/runs?forbidden=1",
      [
        { status: 400, type: "urn:gauntlet:problem:invalid-path" },
        { status: 503, type },
      ],
      malformed,
    );
    await this.#problem("GET", "/_gauntlet/v1/uploads", 503, type);
    await this.#problem(
      "POST",
      `/_gauntlet/v1/operations/${safePathId(operationId)}/runs`,
      503,
      type,
      undefined,
      malformed,
    );
  }
}
