import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { isAdapterTarget } from "@8lines/gauntlet-typescript-node";

type ClientErrorSocket = Pick<Duplex, "destroyed" | "end" | "writableEnded">;

const genericBadRequest = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

type ExceptionalStatus = 405 | 417;

function problemResponse(status: 400 | ExceptionalStatus | 503, type: string, title: string): string {
  const body = JSON.stringify({ type, title, status });
  const reason = {
    400: "Bad Request",
    405: "Method Not Allowed",
    417: "Expectation Failed",
    503: "Service Unavailable",
  }[status];
  return `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/problem+json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
}

function exceptionalProblem(enabled: boolean, status: ExceptionalStatus, type: string, title: string) {
  return enabled
    ? { status, type, title }
    : { status: 503 as const, type: "urn:gauntlet:problem:adapter-disabled", title: "Adapter disabled" };
}

export function handleExceptionalResponse(
  request: Pick<IncomingMessage, "url">,
  response: Pick<ServerResponse, "end" | "writeHead">,
  enabled: boolean,
  status: ExceptionalStatus,
  type: string,
  title: string,
): void {
  if (typeof request.url !== "string" || !isAdapterTarget(request.url)) {
    response.writeHead(status, { "content-length": "0", connection: "close" });
    response.end();
    return;
  }
  const problem = exceptionalProblem(enabled, status, type, title);
  const body = JSON.stringify(problem);
  response.writeHead(problem.status, {
    "content-type": "application/problem+json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  response.end(body);
}

export function handleExceptionalSocket(
  request: Pick<IncomingMessage, "url">,
  socket: ClientErrorSocket,
  enabled: boolean,
  status: ExceptionalStatus,
  type: string,
  title: string,
): void {
  if (socket.destroyed || socket.writableEnded) return;
  if (typeof request.url !== "string" || !isAdapterTarget(request.url)) {
    socket.end(genericBadRequest);
    return;
  }
  const problem = exceptionalProblem(enabled, status, type, title);
  socket.end(problemResponse(problem.status, problem.type, problem.title));
}

export function handleClientError(
  socket: ClientErrorSocket,
  packet: Buffer | undefined,
  enabled: boolean,
): void {
  if (socket.destroyed || socket.writableEnded) return;
  const requestPrefix = packet?.subarray(0, 8192).toString("latin1") ?? "";
  const requestTarget = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+ ([^ \t\r\n]{1,8192})(?:[ \t]|$)/u.exec(requestPrefix)?.[1];
  const adapterPacket = requestTarget !== undefined && isAdapterTarget(requestTarget);
  if (!adapterPacket) {
    socket.end(genericBadRequest);
    return;
  }
  socket.end(enabled
    ? problemResponse(400, "urn:gauntlet:problem:invalid-path", "Invalid path")
    : problemResponse(503, "urn:gauntlet:problem:adapter-disabled", "Adapter disabled"));
}
