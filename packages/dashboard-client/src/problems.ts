import type { Problem } from "@8lines/gauntlet-protocol";

export function invalidPathProblem(): Problem {
  return {
    type: "urn:gauntlet:problem:invalid-path",
    title: "Invalid adapter path",
    status: 400,
  };
}

export function requestValidationProblem(): Problem {
  return {
    type: "urn:gauntlet:problem:validation-failed",
    title: "Request validation failed",
    status: 422,
  };
}

export function payloadTooLargeProblem(): Problem {
  return {
    type: "urn:gauntlet:problem:payload-too-large",
    title: "Payload too large",
    status: 413,
  };
}

export function invalidResponseProblem(): Problem {
  return {
    type: "urn:gauntlet:problem:adapter-invalid-response",
    title: "Invalid adapter response",
    status: 502,
  };
}

export function incompatibleProtocolProblem(): Problem {
  return {
    type: "urn:gauntlet:problem:adapter-protocol-incompatible",
    title: "Incompatible adapter protocol",
    status: 502,
  };
}

export function adapterUnavailableProblem(): Problem {
  return {
    type: "urn:gauntlet:problem:adapter-unavailable",
    title: "Adapter unavailable",
    status: 503,
  };
}
