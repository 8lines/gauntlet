/**
 * Channel-1 message types and strict validators shared by the Gauntlet widget
 * loader and panel. See docs/superpowers/specs/2026-09-25-embeddable-widget-design.md,
 * section "Channel protocol".
 */

export const WIDGET_CHANNEL_VERSION = 1 as const;

export const MAX_SUBJECTS = 16;
export const MAX_SUBJECT_VALUES = 16;
export const MAX_STRING_LENGTH = 512;

export type SubjectValue = string | number | boolean;

export interface PageSubject {
  readonly type: string;
  readonly values: Readonly<Record<string, SubjectValue>>;
}

export interface PageContext {
  readonly target: string;
  readonly subjects: readonly PageSubject[];
}

export type HandshakeMessage =
  | { readonly channel: 1; readonly type: "gauntlet:ready" }
  | { readonly channel: 1; readonly type: "gauntlet:connect"; readonly target: string }
  | { readonly channel: 1; readonly type: "gauntlet:rejected" };

export type HostMessage =
  | { readonly channel: 1; readonly type: "gauntlet:context"; readonly context: PageContext }
  | { readonly channel: 1; readonly type: "gauntlet:open" };

export type PanelMessage =
  | { readonly channel: 1; readonly type: "gauntlet:state"; readonly contextualCount: number; readonly globalCount: number }
  | { readonly channel: 1; readonly type: "gauntlet:close" }
  | { readonly channel: 1; readonly type: "gauntlet:resize"; readonly expanded: boolean };

export type ParseResult<T> =
  | { readonly kind: "message"; readonly message: T }
  | { readonly kind: "unknown"; readonly type: string }
  | { readonly kind: "invalid" };

const PORTABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * A plain record is a non-null, non-array object whose prototype is exactly
 * `Object.prototype` or `null`. Values posted through `postMessage` are
 * structured clones, so restricting to own enumerable data properties on such
 * a prototype is enough to rule out prototype-chain surprises.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reads `key` from `record` only if it is an own *data* property, never an
 * accessor. Returns `undefined` for missing properties and for getters
 * alike, which every caller already treats as "absent" and therefore
 * invalid.
 */
function ownValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

export function isPortableId(value: unknown): value is string {
  return typeof value === "string" && PORTABLE_ID_PATTERN.test(value);
}

export function isSubjectValues(value: unknown): value is Readonly<Record<string, SubjectValue>> {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length > MAX_SUBJECT_VALUES) return false;
  for (const key of keys) {
    if (!isPortableId(key)) return false;
    const entry = ownValue(value, key);
    if (typeof entry === "string") {
      if (entry.length > MAX_STRING_LENGTH) return false;
    } else if (typeof entry === "number") {
      if (!Number.isFinite(entry)) return false;
    } else if (typeof entry !== "boolean") {
      return false;
    }
  }
  return true;
}

export function isPageContext(value: unknown): value is PageContext {
  if (!isPlainRecord(value)) return false;
  if (!isPortableId(ownValue(value, "target"))) return false;
  const subjects = ownValue(value, "subjects");
  if (!Array.isArray(subjects) || subjects.length > MAX_SUBJECTS) return false;
  const seenTypes = new Set<string>();
  for (const subject of subjects) {
    if (!isPlainRecord(subject)) return false;
    const type = ownValue(subject, "type");
    if (!isPortableId(type) || !isSubjectValues(ownValue(subject, "values"))) return false;
    if (seenTypes.has(type)) return false;
    seenTypes.add(type);
  }
  return true;
}

function cloneSubjectValues(values: Readonly<Record<string, SubjectValue>>): Readonly<Record<string, SubjectValue>> {
  return { ...values };
}

function clonePageContext(context: PageContext): PageContext {
  return {
    target: context.target,
    subjects: context.subjects.map((subject) => ({ type: subject.type, values: cloneSubjectValues(subject.values) })),
  };
}

/**
 * Returns the message `type` when `data` is a plain record with an own
 * `channel === 1` and an own string `type` starting with `"gauntlet:"`.
 * Otherwise returns `undefined`, which callers treat as `invalid`.
 */
function baseType(data: unknown): string | undefined {
  if (!isPlainRecord(data)) return undefined;
  if (ownValue(data, "channel") !== 1) return undefined;
  const type = ownValue(data, "type");
  if (typeof type !== "string" || !type.startsWith("gauntlet:")) return undefined;
  return type;
}

export function parseHandshakeMessage(data: unknown): ParseResult<HandshakeMessage> {
  const type = baseType(data);
  if (type === undefined) return { kind: "invalid" };
  const record = data as Record<string, unknown>;
  switch (type) {
    case "gauntlet:ready":
      return { kind: "message", message: { channel: 1, type: "gauntlet:ready" } };
    case "gauntlet:connect": {
      const target = ownValue(record, "target");
      if (!isPortableId(target)) return { kind: "invalid" };
      return { kind: "message", message: { channel: 1, type: "gauntlet:connect", target } };
    }
    case "gauntlet:rejected":
      return { kind: "message", message: { channel: 1, type: "gauntlet:rejected" } };
    default:
      return { kind: "unknown", type };
  }
}

export function parseHostMessage(data: unknown): ParseResult<HostMessage> {
  const type = baseType(data);
  if (type === undefined) return { kind: "invalid" };
  const record = data as Record<string, unknown>;
  switch (type) {
    case "gauntlet:context": {
      const context = ownValue(record, "context");
      if (!isPageContext(context)) return { kind: "invalid" };
      return { kind: "message", message: { channel: 1, type: "gauntlet:context", context: clonePageContext(context) } };
    }
    case "gauntlet:open":
      return { kind: "message", message: { channel: 1, type: "gauntlet:open" } };
    default:
      return { kind: "unknown", type };
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parsePanelMessage(data: unknown): ParseResult<PanelMessage> {
  const type = baseType(data);
  if (type === undefined) return { kind: "invalid" };
  const record = data as Record<string, unknown>;
  switch (type) {
    case "gauntlet:state": {
      const contextualCount = ownValue(record, "contextualCount");
      const globalCount = ownValue(record, "globalCount");
      if (!isNonNegativeInteger(contextualCount) || !isNonNegativeInteger(globalCount)) return { kind: "invalid" };
      return { kind: "message", message: { channel: 1, type: "gauntlet:state", contextualCount, globalCount } };
    }
    case "gauntlet:close":
      return { kind: "message", message: { channel: 1, type: "gauntlet:close" } };
    case "gauntlet:resize": {
      const expanded = ownValue(record, "expanded");
      if (typeof expanded !== "boolean") return { kind: "invalid" };
      return { kind: "message", message: { channel: 1, type: "gauntlet:resize", expanded } };
    }
    default:
      return { kind: "unknown", type };
  }
}
