import {
  computeRevision,
  isProtocolId,
  type FeatureDefinition,
  type JsonObject,
} from "@8lines/gauntlet-protocol";
import {
  cloneAndDeepFreeze,
  isCanonicalOperation,
} from "./operation-internals.js";
import type { RegisteredOperation } from "./operation.js";

export class OperationRegistry {
  readonly #features = new Map<string, FeatureDefinition>();
  readonly #operations = new Map<string, RegisteredOperation>();

  registerFeature(feature: FeatureDefinition): void {
    if (!isProtocolId(feature.id)) {
      throw new TypeError(`Invalid feature ID: ${feature.id}`);
    }
    if (this.#features.has(feature.id)) {
      throw new TypeError(`Duplicate feature ID: ${feature.id}`);
    }
    if (feature.parentId !== undefined) {
      if (!isProtocolId(feature.parentId)) {
        throw new TypeError(`Invalid parent feature ID: ${feature.parentId}`);
      }
      if (!this.#features.has(feature.parentId)) {
        throw new TypeError(`Unknown parent feature: ${feature.parentId}`);
      }
    }

    this.#features.set(feature.id, cloneAndDeepFreeze(feature));
  }

  register<I extends JsonObject>(operation: RegisteredOperation<I>): void {
    const { id, featureId } = operation.definition;
    if (!isProtocolId(id)) {
      throw new TypeError(`Invalid operation ID: ${id}`);
    }
    if (!isProtocolId(featureId)) {
      throw new TypeError(`Invalid feature ID: ${featureId}`);
    }
    if (!isCanonicalOperation(operation)) {
      throw new TypeError("Operation must be created by defineOperation");
    }
    if (computeRevision(operation.definition as unknown as JsonObject) !== operation.definition.revision) {
      throw new TypeError(`Operation revision integrity check failed: ${id}`);
    }
    if (this.#operations.has(id)) {
      throw new TypeError(`Duplicate operation ID: ${id}`);
    }
    if (!this.#features.has(featureId)) {
      throw new TypeError(`Unknown feature: ${featureId}`);
    }

    this.#operations.set(id, operation as unknown as RegisteredOperation);
  }

  get(id: string): RegisteredOperation | undefined {
    return this.#operations.get(id);
  }

  require(id: string): RegisteredOperation {
    const operation = this.get(id);
    if (operation === undefined) {
      throw new TypeError(`Unknown operation: ${id}`);
    }
    return operation;
  }

  features(): readonly FeatureDefinition[] {
    return [...this.#features.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  operations(): readonly RegisteredOperation[] {
    return [...this.#operations.values()].sort((left, right) =>
      left.definition.id.localeCompare(right.definition.id));
  }
}
