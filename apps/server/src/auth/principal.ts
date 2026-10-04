import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyRequest } from "fastify";

export type Principal =
  | { readonly kind: "anonymous" }
  | { readonly kind: "shared"; readonly id: "shared"; readonly displayName: "Shared password" }
  | { readonly kind: "user"; readonly id: `user:${string}`; readonly displayName: string }
  | { readonly kind: "token"; readonly id: `token:${string}`; readonly displayName: string };

export type AuthenticatedPrincipal = Exclude<Principal, { readonly kind: "anonymous" }>;

export const ANONYMOUS: Principal = Object.freeze({ kind: "anonymous" });

/** The run actor recorded for a principal; anonymous callers record none. */
export function principalActor(principal: Principal): { readonly id: string; readonly displayName: string } | undefined {
  return principal.kind === "anonymous" ? undefined : Object.freeze({ id: principal.id, displayName: principal.displayName });
}

/** Carries the principal into code that only sees the raw request, such as the MCP SDK handlers. */
export const principalStorage = new AsyncLocalStorage<Principal>();

const principals = new WeakMap<FastifyRequest, Principal>();

export function setRequestPrincipal(request: FastifyRequest, principal: Principal): void {
  principals.set(request, principal);
}

export function requestPrincipal(request: FastifyRequest): Principal {
  return principals.get(request) ?? ANONYMOUS;
}
