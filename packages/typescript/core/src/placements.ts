import type { OperationPlacement } from "@8lines/gauntlet-protocol";

export function globalPlacement(): OperationPlacement {
  return { kind: "global" };
}

export function subjectPlacement(
  subjectType: string,
  bindings?: Readonly<Record<string, string>>,
): OperationPlacement {
  // The canonical wire form never carries an empty bindings object.
  return bindings === undefined || Object.keys(bindings).length === 0
    ? { kind: "subject", subjectType }
    : { kind: "subject", subjectType, bindings };
}
