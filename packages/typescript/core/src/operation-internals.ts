const canonicalOperations = new WeakSet<object>();

function failCanonicalJson(): never {
  throw new TypeError("Value must be canonical plain JSON");
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertCanonicalJson(
  value: unknown,
  active: Set<object>,
  visited: Set<object>,
): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) failCanonicalJson();
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) failCanonicalJson();
    const serialized = JSON.stringify(value);
    if (Number.isInteger(value)
      && !Number.isSafeInteger(value)
      && !/[eE]/.test(serialized)) {
      failCanonicalJson();
    }
    return;
  }
  if (typeof value !== "object") failCanonicalJson();
  if (active.has(value)) failCanonicalJson();
  if (visited.has(value)) return;

  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) failCanonicalJson();
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key !== "string")) failCanonicalJson();
      if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) failCanonicalJson();
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        if (!Object.hasOwn(value, key)) failCanonicalJson();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          failCanonicalJson();
        }
        assertCanonicalJson(descriptor.value, active, visited);
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) failCanonicalJson();
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") failCanonicalJson();
        if (hasLoneSurrogate(key)) failCanonicalJson();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          failCanonicalJson();
        }
        assertCanonicalJson(descriptor.value, active, visited);
      }
    }
  } finally {
    active.delete(value);
  }
  visited.add(value);
}

export function assertCanonicalJsonValue(value: unknown): void {
  assertCanonicalJson(value, new Set(), new Set());
}

function cloneOwnedJson(value: unknown, clones: Map<object, unknown>): unknown {
  if (value === null || typeof value !== "object") return value;
  const existing = clones.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    clones.set(value, clone);
    for (let index = 0; index < value.length; index += 1) {
      clone.push(cloneOwnedJson(value[index], clones));
    }
    return Object.freeze(clone);
  }

  const clone = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  clones.set(value, clone);
  for (const key of Object.keys(value)) {
    Object.defineProperty(clone, key, {
      value: cloneOwnedJson((value as Record<string, unknown>)[key], clones),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(clone);
}

export function cloneAndDeepFreeze<T>(value: T): T {
  assertCanonicalJsonValue(value);
  return cloneOwnedJson(value, new Map()) as T;
}

export function markCanonicalOperation(operation: object): void {
  canonicalOperations.add(operation);
}

export function isCanonicalOperation(operation: object): boolean {
  return canonicalOperations.has(operation);
}
