/**
 * Overlays explicit `setSubject` values onto URL-derived subjects, and
 * compares resulting `PageContext`s for the loader's change detection.
 * See docs/superpowers/specs/2026-09-25-embeddable-widget-design.md,
 * section "Effective page context".
 */

import { isPageContext, type PageContext, type PageSubject, type SubjectValue } from "@8lines/gauntlet-widget-channel";
import type { SubjectValues } from "@8lines/gauntlet-widget";

export function mergeSubjects(fromUrl: readonly PageSubject[], explicit: ReadonlyMap<string, SubjectValues>): PageSubject[] {
  const result: PageSubject[] = [];
  const seenTypes = new Set<string>();
  for (const subject of fromUrl) {
    seenTypes.add(subject.type);
    const override = explicit.get(subject.type);
    result.push(override === undefined ? subject : { type: subject.type, values: { ...override } });
  }
  for (const [type, values] of explicit) {
    if (seenTypes.has(type)) continue;
    result.push({ type, values: { ...values } });
  }
  return result;
}

/**
 * The context to send for `target`: the merged subjects, or no subjects when
 * the merge exceeds the channel limits, so the panel never keeps stale ones.
 */
export function pageContext(
  target: string,
  fromUrl: readonly PageSubject[],
  explicit: ReadonlyMap<string, SubjectValues>,
): { readonly context: PageContext; readonly withinLimits: boolean } {
  const context: PageContext = { target, subjects: mergeSubjects(fromUrl, explicit) };
  if (isPageContext(context)) return { context, withinLimits: true };
  return { context: { target, subjects: [] }, withinLimits: false };
}

function sameValues(a: Readonly<Record<string, SubjectValue>>, b: Readonly<Record<string, SubjectValue>>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key)) return false;
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function sameContext(a: PageContext | undefined, b: PageContext): boolean {
  if (a === undefined) return false;
  if (a.target !== b.target) return false;
  if (a.subjects.length !== b.subjects.length) return false;
  for (let i = 0; i < a.subjects.length; i++) {
    const subjectA = a.subjects[i]!;
    const subjectB = b.subjects[i]!;
    if (subjectA.type !== subjectB.type) return false;
    if (!sameValues(subjectA.values, subjectB.values)) return false;
  }
  return true;
}
