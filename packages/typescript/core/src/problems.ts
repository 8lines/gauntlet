import type { Problem, ValidationError } from "@8lines/gauntlet-protocol";
import { cloneAndDeepFreeze } from "./operation-internals.js";

export function operationNotFoundProblem(): Problem {
  return {
    type: "urn:gauntlet:problem:operation-not-found",
    title: "Operation not found",
    status: 404,
  };
}

export function dataSourceNotFoundProblem(): Problem {
  return {
    type: "urn:gauntlet:problem:data-source-not-found",
    title: "Data source not found",
    status: 404,
  };
}

export function staleOperationRevisionProblem(): Problem {
  return {
    type: "urn:gauntlet:problem:stale-operation-revision",
    title: "Operation revision is stale",
    status: 409,
  };
}

export function operationBusyProblem(): Problem {
  return {
    type: "urn:gauntlet:problem:operation-busy",
    title: "Operation busy",
    status: 409,
  };
}

export function runNotFoundProblem(): Problem {
  return {
    type: "urn:gauntlet:problem:run-not-found",
    title: "Run not found",
    status: 404,
  };
}

export function runNotCancellableProblem(): Problem {
  return {
    type: "urn:gauntlet:problem:run-not-cancellable",
    title: "Run is not cancellable",
    status: 409,
  };
}

export function runCancelledProblem(): Problem {
  return {
    type: "urn:gauntlet:problem:run-cancelled",
    title: "Run cancelled",
    status: 409,
  };
}

export function runTimedOutProblem(): Problem {
  return {
    type: "urn:gauntlet:problem:run-timed-out",
    title: "Run timed out",
    status: 504,
  };
}

export function validationFailedProblem(errors: readonly ValidationError[]): Problem {
  const ownedErrors = cloneAndDeepFreeze(errors);
  return cloneAndDeepFreeze<Problem>({
    type: "urn:gauntlet:problem:validation-failed",
    title: "Validation failed",
    status: 422,
    ...(ownedErrors.length === 0 ? {} : { errors: ownedErrors }),
  });
}

export function handlerFailedProblem(): Problem {
  return {
    type: "urn:gauntlet:problem:handler-failed",
    title: "Operation failed",
    status: 500,
  };
}

export function adapterInternalErrorProblem(): Problem {
  return {
    type: "urn:gauntlet:problem:adapter-internal-error",
    title: "Adapter internal error",
    status: 500,
  };
}
