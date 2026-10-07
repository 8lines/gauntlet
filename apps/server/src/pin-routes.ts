import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requestPrincipal } from "./auth/principal.js";
import type { PinStore } from "./pin-store.js";
import {
  INVALID_PATH_PROBLEM,
  PIN_LIMIT_PROBLEM,
  PINS_UNAVAILABLE_PROBLEM,
  sendProblem,
  TARGET_NOT_FOUND_PROBLEM,
} from "./problem-response.js";
import { pathIds } from "./routes.js";
import type { TargetRegistry } from "./target-registry.js";

export interface PinRouteDependencies {
  readonly pins: PinStore;
  readonly registry: TargetRegistry;
  readonly clock: () => Date;
}

/** Pins of the anonymous principal, shared by everyone while authentication is disabled. */
const ANONYMOUS_PRINCIPAL_ID = "anonymous";

function principalId(request: FastifyRequest): string {
  const principal = requestPrincipal(request);
  return principal.kind === "anonymous" ? ANONYMOUS_PRINCIPAL_ID : principal.id;
}

/**
 * `/api/v1/targets/:targetId/pins`. The operation is deliberately not checked against the
 * manifest: a pin outlives an operation that disappears and applies again when it comes back.
 */
export function registerPinRoutes(app: FastifyInstance, dependencies: PinRouteDependencies): void {
  /** The path ids when they are valid and name a known target; otherwise sends the problem. */
  function resolve(request: FastifyRequest, reply: FastifyReply, keys: readonly string[]): readonly string[] | undefined {
    const ids = pathIds(request, keys);
    if (ids === undefined) {
      sendProblem(reply, INVALID_PATH_PROBLEM);
      return undefined;
    }
    if (dependencies.registry.get(ids[0]!) === undefined) {
      sendProblem(reply, TARGET_NOT_FOUND_PROBLEM);
      return undefined;
    }
    return ids;
  }

  app.get("/api/v1/targets/:targetId/pins", async (request, reply) => {
    const ids = resolve(request, reply, ["targetId"]);
    if (ids === undefined) return reply;
    try {
      const pins = dependencies.pins.list(principalId(request), ids[0]!);
      return reply.code(200).send({ pins });
    } catch {
      return sendProblem(reply, PINS_UNAVAILABLE_PROBLEM);
    }
  });

  app.put("/api/v1/targets/:targetId/pins/:operationId", async (request, reply) => {
    const ids = resolve(request, reply, ["targetId", "operationId"]);
    if (ids === undefined) return reply;
    const [targetId, operationId] = ids as readonly [string, string];
    try {
      const result = dependencies.pins.pin(principalId(request), targetId, operationId, dependencies.clock());
      return result.ok ? reply.code(204).send() : sendProblem(reply, PIN_LIMIT_PROBLEM);
    } catch {
      return sendProblem(reply, PINS_UNAVAILABLE_PROBLEM);
    }
  });

  app.delete("/api/v1/targets/:targetId/pins/:operationId", async (request, reply) => {
    const ids = resolve(request, reply, ["targetId", "operationId"]);
    if (ids === undefined) return reply;
    const [targetId, operationId] = ids as readonly [string, string];
    try {
      dependencies.pins.unpin(principalId(request), targetId, operationId);
      return reply.code(204).send();
    } catch {
      return sendProblem(reply, PINS_UNAVAILABLE_PROBLEM);
    }
  });
}
