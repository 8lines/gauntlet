/**
 * Pure compilation and matching of `RouteRule[]` (see `@8lines/gauntlet-widget`)
 * against `location.pathname`. See docs/superpowers/specs/2026-09-25-embeddable-widget-design.md,
 * section "Route rules".
 */

import { isPortableId, MAX_STRING_LENGTH, MAX_SUBJECT_VALUES, MAX_SUBJECTS, type PageSubject } from "@8lines/gauntlet-widget-channel";

const PARAM_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

type Segment = { readonly kind: "literal"; readonly value: string } | { readonly kind: "param"; readonly name: string } | { readonly kind: "rest" };

interface SubjectMapping {
  readonly type: string;
  readonly params: readonly string[];
}

export interface CompiledRoute {
  readonly pattern: string;
}

interface CompiledRouteInternal extends CompiledRoute {
  readonly segments: readonly Segment[];
  readonly subjects: readonly SubjectMapping[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compileSegments(pattern: string): readonly Segment[] | undefined {
  if (!pattern.startsWith("/")) return undefined;
  const raw = pattern.slice(1).split("/");
  // One trailing slash is optional, as in paths: "/" is the root and "/orders/:id/" equals "/orders/:id".
  if (raw[raw.length - 1] === "") raw.pop();
  const segments: Segment[] = [];
  const seenParams = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const piece = raw[i]!;
    if (piece === "") return undefined;
    if (piece === "*") {
      if (i !== raw.length - 1) return undefined;
      segments.push({ kind: "rest" });
    } else if (piece.startsWith(":")) {
      const name = piece.slice(1);
      if (!PARAM_NAME_PATTERN.test(name) || seenParams.has(name) || seenParams.size >= MAX_SUBJECT_VALUES) return undefined;
      seenParams.add(name);
      segments.push({ kind: "param", name });
    } else {
      segments.push({ kind: "literal", value: piece });
    }
  }
  return segments;
}

function compileSubjects(record: Record<string, unknown>, paramNames: ReadonlySet<string>): readonly SubjectMapping[] | undefined {
  const hasSubject = "subject" in record;
  const hasSubjects = "subjects" in record;
  if (hasSubject === hasSubjects) return undefined;
  if (hasSubject) {
    const subject = record["subject"];
    if (!isPortableId(subject)) return undefined;
    return [{ type: subject, params: [...paramNames] }];
  }
  const subjectsValue = record["subjects"];
  if (!isPlainObject(subjectsValue)) return undefined;
  const entries = Object.entries(subjectsValue);
  if (entries.length === 0 || entries.length > MAX_SUBJECTS) return undefined;
  const mappings: SubjectMapping[] = [];
  for (const [type, params] of entries) {
    if (!isPortableId(type)) return undefined;
    if (!Array.isArray(params)) return undefined;
    const paramList: string[] = [];
    for (const param of params) {
      if (typeof param !== "string" || !paramNames.has(param)) return undefined;
      paramList.push(param);
    }
    mappings.push({ type, params: paramList });
  }
  return mappings;
}

function compileRule(rule: unknown): CompiledRouteInternal | undefined {
  if (!isPlainObject(rule)) return undefined;
  const pattern = rule["pattern"];
  if (typeof pattern !== "string") return undefined;
  const segments = compileSegments(pattern);
  if (segments === undefined) return undefined;
  const paramNames = new Set(segments.flatMap((segment) => (segment.kind === "param" ? [segment.name] : [])));
  const subjects = compileSubjects(rule, paramNames);
  if (subjects === undefined) return undefined;
  return { pattern, segments, subjects };
}

export function compileRoutes(rules: unknown): readonly CompiledRoute[] | undefined {
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) return undefined;
  const compiled: CompiledRouteInternal[] = [];
  for (const rule of rules) {
    const entry = compileRule(rule);
    if (entry === undefined) return undefined;
    compiled.push(entry);
  }
  return compiled;
}

function splitPath(pathname: string): readonly string[] {
  const withoutLeadingSlash = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  const segments = withoutLeadingSlash.split("/");
  if (segments.length > 0 && segments[segments.length - 1] === "") {
    segments.pop();
  }
  return segments;
}

function matchSegments(segments: readonly Segment[], pathSegments: readonly string[]): ReadonlyMap<string, string> | undefined {
  const captured = new Map<string, string>();
  let pathIndex = 0;
  for (const segment of segments) {
    if (segment.kind === "rest") return captured;
    const raw = pathSegments[pathIndex];
    if (raw === undefined || raw === "") return undefined;
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (segment.kind === "literal") {
      if (decoded !== segment.value) return undefined;
    } else {
      if (decoded.length > MAX_STRING_LENGTH) return undefined;
      captured.set(segment.name, decoded);
    }
    pathIndex++;
  }
  if (pathIndex !== pathSegments.length) return undefined;
  return captured;
}

export function subjectsForPath(routes: readonly CompiledRoute[], pathname: string): PageSubject[] {
  const pathSegments = splitPath(pathname);
  for (const route of routes as readonly CompiledRouteInternal[]) {
    const captured = matchSegments(route.segments, pathSegments);
    if (captured === undefined) continue;
    return route.subjects.map((mapping) => ({
      type: mapping.type,
      values: Object.fromEntries(mapping.params.map((param) => [param, captured.get(param)!])),
    }));
  }
  return [];
}
