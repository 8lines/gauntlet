import type { Problem } from "@8lines/gauntlet-protocol";

export function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  const output = new Headers(headers); output.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers: output });
}
export function problemResponse(problem: Problem): Response {
  return new Response(JSON.stringify(problem), { status: problem.status, headers: { "content-type": "application/problem+json; charset=utf-8" } });
}
export const problem = (type: Problem["type"], title: string, status: number): Problem => ({ type, title, status });
