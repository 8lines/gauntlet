type Interval = readonly [start: number, end: number];

interface Position {
  readonly id: number;
  readonly characters: readonly Interval[];
}

interface Analysis {
  readonly nullableDerivations: number;
  readonly first: readonly Position[];
  readonly last: readonly Position[];
}

interface Quantifier {
  readonly minimum: number;
  readonly maximum: number;
}

const MAX_PATTERN_CODE_UNITS = 512;
const MAX_QUANTIFIER_BOUND = 1000;
const UNBOUNDED = Number.POSITIVE_INFINITY;
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;
const MAX_SCALAR = 0x10ffff;
const SCALAR_UNIVERSE: readonly Interval[] = [
  [0, HIGH_SURROGATE_START - 1],
  [LOW_SURROGATE_END + 1, MAX_SCALAR],
];
const EXTERNAL_ESCAPES = new Set("\\^$.*+?()[]{}|/");
const CLASS_ESCAPES = new Set(["\\", "]", "^", "-"]);
const EMPTY: Analysis = { nullableDerivations: 1, first: [], last: [] };

class PortablePatternError extends Error {}

function invalid(): never {
  throw new PortablePatternError();
}

function isControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= HIGH_SURROGATE_START && codeUnit <= HIGH_SURROGATE_END;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= LOW_SURROGATE_START && codeUnit <= LOW_SURROGATE_END;
}

function unionPositions(
  left: readonly Position[],
  right: readonly Position[],
): readonly Position[] {
  if (left.length === 0) {
    return right;
  }
  if (right.length === 0) {
    return left;
  }

  const result = [...left];
  const seen = new Set(left.map(({ id }) => id));
  for (const position of right) {
    if (!seen.has(position.id)) {
      result.push(position);
      seen.add(position.id);
    }
  }
  return result;
}

function normalizeIntervals(intervals: readonly Interval[]): readonly Interval[] {
  const sorted = [...intervals].sort(([leftStart, leftEnd], [rightStart, rightEnd]) => (
    leftStart - rightStart || leftEnd - rightEnd
  ));
  const result: Interval[] = [];

  for (const [start, end] of sorted) {
    const previous = result.at(-1);
    if (previous === undefined || start > previous[1] + 1) {
      result.push([start, end]);
      continue;
    }
    result[result.length - 1] = [previous[0], Math.max(previous[1], end)];
  }
  return result;
}

function complementIntervals(intervals: readonly Interval[]): readonly Interval[] {
  const excluded = normalizeIntervals(intervals);
  const result: Interval[] = [];

  for (const [universeStart, universeEnd] of SCALAR_UNIVERSE) {
    let cursor = universeStart;
    for (const [excludedStart, excludedEnd] of excluded) {
      if (excludedEnd < cursor || excludedStart > universeEnd) {
        continue;
      }
      if (excludedStart > cursor) {
        result.push([cursor, Math.min(excludedStart - 1, universeEnd)]);
      }
      cursor = Math.max(cursor, excludedEnd + 1);
      if (cursor > universeEnd) {
        break;
      }
    }
    if (cursor <= universeEnd) {
      result.push([cursor, universeEnd]);
    }
  }
  return result;
}

function intervalsOverlap(left: readonly Interval[], right: readonly Interval[]): boolean {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const [leftStart, leftEnd] = left[leftIndex]!;
    const [rightStart, rightEnd] = right[rightIndex]!;
    if (leftEnd < rightStart) {
      leftIndex += 1;
    } else if (rightEnd < leftStart) {
      rightIndex += 1;
    } else {
      return true;
    }
  }
  return false;
}

function isScalarUniverse(intervals: readonly Interval[]): boolean {
  return intervals.length === SCALAR_UNIVERSE.length
    && intervals.every(([start, end], index) => (
      start === SCALAR_UNIVERSE[index]![0] && end === SCALAR_UNIVERSE[index]![1]
    ));
}

class Parser {
  readonly #pattern: string;
  readonly #outgoing = new Map<number, Position[]>();
  #hasUnboundedQuantifier = false;
  #index = 0;
  #nextPositionId = 0;
  #rootHasAlternation = false;

  constructor(pattern: string) {
    this.#pattern = pattern;
  }

  parse(): void {
    const expression = this.#parseDisjunction(true);
    if (this.#index !== this.#pattern.length) {
      invalid();
    }
    if (
      this.#hasUnboundedQuantifier
      && (this.#pattern[0] !== "^" || this.#rootHasAlternation)
    ) {
      invalid();
    }
    this.#assertDisjoint(expression.first);
  }

  #parseDisjunction(isRoot = false): Analysis {
    let result = this.#parseAlternative();
    while (this.#peek() === "|") {
      if (isRoot) {
        this.#rootHasAlternation = true;
      }
      this.#index += 1;
      result = this.#alternate(result, this.#parseAlternative());
    }
    return result;
  }

  #parseAlternative(): Analysis {
    let result = EMPTY;
    while (this.#index < this.#pattern.length) {
      const character = this.#peek();
      if (character === "|" || character === ")") {
        break;
      }
      result = this.#concatenate(result, this.#parseTerm());
    }
    return result;
  }

  #parseTerm(): Analysis {
    const character = this.#peek();
    if (character === "^" || character === "$") {
      this.#index += 1;
      if (this.#isQuantifierStart(this.#peek())) {
        invalid();
      }
      return EMPTY;
    }

    if (character === undefined || this.#isQuantifierStart(character) || character === "}") {
      return invalid();
    }

    let atom = this.#parseAtom();
    if (this.#isQuantifierStart(this.#peek())) {
      const quantifier = this.#parseQuantifier();
      if (quantifier.maximum === UNBOUNDED) {
        this.#hasUnboundedQuantifier = true;
      }
      atom = this.#repeat(atom, quantifier);
      if (this.#isQuantifierStart(this.#peek())) {
        invalid();
      }
    }
    return atom;
  }

  #parseAtom(): Analysis {
    const character = this.#peek();
    if (character === "(") {
      this.#index += 1;
      if (this.#peek() === "?") {
        if (this.#pattern[this.#index + 1] !== ":") {
          return invalid();
        }
        this.#index += 2;
      }
      const body = this.#parseDisjunction();
      if (this.#peek() !== ")") {
        return invalid();
      }
      this.#index += 1;
      return body;
    }

    if (character === "[") {
      return this.#parseClass();
    }

    if (character === "\\") {
      this.#index += 1;
      const escaped = this.#peek();
      if (escaped === undefined || !EXTERNAL_ESCAPES.has(escaped)) {
        return invalid();
      }
      this.#index += 1;
      return this.#position(escaped.codePointAt(0)!);
    }

    if (
      character === undefined
      || character === "."
      || character === ")"
      || character === "]"
      || character === "{"
      || character === "|"
    ) {
      return invalid();
    }

    return this.#position(this.#readRawScalar());
  }

  #parseClass(): Analysis {
    this.#index += 1;
    const negated = this.#peek() === "^";
    if (negated) {
      this.#index += 1;
    }

    const intervals: Interval[] = [];
    let itemCount = 0;
    while (this.#index < this.#pattern.length && this.#peek() !== "]") {
      if (this.#pattern.startsWith("&&", this.#index) || this.#pattern.startsWith("--", this.#index)) {
        return invalid();
      }

      const start = this.#readClassScalar();
      itemCount += 1;
      if (this.#peek() === "-" && this.#pattern[this.#index + 1] !== "]") {
        if (this.#pattern[this.#index + 1] === "-") {
          return invalid();
        }
        this.#index += 1;
        const end = this.#readClassScalar();
        if (start > end || (start < HIGH_SURROGATE_START && end > LOW_SURROGATE_END)) {
          return invalid();
        }
        intervals.push([start, end]);
      } else {
        intervals.push([start, start]);
      }
    }

    if (this.#peek() !== "]" || itemCount === 0) {
      return invalid();
    }
    this.#index += 1;

    const characters = negated
      ? complementIntervals(intervals)
      : normalizeIntervals(intervals);
    if (characters.length === 0 || isScalarUniverse(characters)) {
      return invalid();
    }
    return this.#positionWithIntervals(characters);
  }

  #readClassScalar(): number {
    const character = this.#peek();
    if (character === undefined || character === "]" || character === "[") {
      return invalid();
    }
    if (character === "\\") {
      this.#index += 1;
      const escaped = this.#peek();
      if (escaped === undefined || !CLASS_ESCAPES.has(escaped)) {
        return invalid();
      }
      this.#index += 1;
      return escaped.codePointAt(0)!;
    }
    return this.#readRawScalar();
  }

  #readRawScalar(): number {
    const first = this.#pattern.charCodeAt(this.#index);
    if (Number.isNaN(first)) {
      return invalid();
    }

    let codePoint = first;
    if (isHighSurrogate(first)) {
      const second = this.#pattern.charCodeAt(this.#index + 1);
      if (!isLowSurrogate(second)) {
        return invalid();
      }
      codePoint = ((first - HIGH_SURROGATE_START) * 0x400)
        + (second - LOW_SURROGATE_START)
        + 0x10000;
      this.#index += 2;
    } else {
      if (isLowSurrogate(first)) {
        return invalid();
      }
      this.#index += 1;
    }

    if (isControl(codePoint)) {
      return invalid();
    }
    return codePoint;
  }

  #parseQuantifier(): Quantifier {
    const character = this.#peek();
    if (character === "?") {
      this.#index += 1;
      return { minimum: 0, maximum: 1 };
    }
    if (character === "*") {
      this.#index += 1;
      return { minimum: 0, maximum: UNBOUNDED };
    }
    if (character === "+") {
      this.#index += 1;
      return { minimum: 1, maximum: UNBOUNDED };
    }
    if (character !== "{") {
      return invalid();
    }

    this.#index += 1;
    const minimum = this.#parseBound();
    if (this.#peek() === "}") {
      this.#index += 1;
      return { minimum, maximum: minimum };
    }
    if (this.#peek() !== ",") {
      return invalid();
    }

    this.#index += 1;
    if (this.#peek() === "}") {
      this.#index += 1;
      return { minimum, maximum: UNBOUNDED };
    }
    const maximum = this.#parseBound();
    if (this.#peek() !== "}" || minimum > maximum) {
      return invalid();
    }
    this.#index += 1;
    return { minimum, maximum };
  }

  #parseBound(): number {
    const start = this.#index;
    while (this.#isAsciiDigit(this.#peek())) {
      this.#index += 1;
    }
    if (start === this.#index) {
      return invalid();
    }

    const text = this.#pattern.slice(start, this.#index);
    if ((text.length > 1 && text.startsWith("0")) || text.length > 4) {
      return invalid();
    }
    const value = Number(text);
    if (value > MAX_QUANTIFIER_BOUND) {
      return invalid();
    }
    return value;
  }

  #position(codePoint: number): Analysis {
    return this.#positionWithIntervals([[codePoint, codePoint]]);
  }

  #positionWithIntervals(characters: readonly Interval[]): Analysis {
    const position: Position = {
      id: this.#nextPositionId,
      characters,
    };
    this.#nextPositionId += 1;
    return { nullableDerivations: 0, first: [position], last: [position] };
  }

  #alternate(left: Analysis, right: Analysis): Analysis {
    const nullableDerivations = left.nullableDerivations + right.nullableDerivations;
    if (nullableDerivations > 1) {
      return invalid();
    }
    return {
      nullableDerivations,
      first: unionPositions(left.first, right.first),
      last: unionPositions(left.last, right.last),
    };
  }

  #concatenate(left: Analysis, right: Analysis): Analysis {
    this.#addTransitions(left.last, right.first);
    const nullableDerivations = left.nullableDerivations * right.nullableDerivations;
    if (nullableDerivations > 1) {
      return invalid();
    }
    return {
      nullableDerivations,
      first: left.nullableDerivations > 0 ? unionPositions(left.first, right.first) : left.first,
      last: right.nullableDerivations > 0 ? unionPositions(left.last, right.last) : right.last,
    };
  }

  #repeat(body: Analysis, quantifier: Quantifier): Analysis {
    if (quantifier.maximum === 0) {
      return EMPTY;
    }
    if (quantifier.maximum > 1) {
      if (body.nullableDerivations > 0) {
        return invalid();
      }
      this.#addTransitions(body.last, body.first);
    } else if (quantifier.minimum === 0 && body.nullableDerivations > 0) {
      return invalid();
    }
    return {
      nullableDerivations: quantifier.minimum === 0 ? 1 : body.nullableDerivations,
      first: body.first,
      last: body.last,
    };
  }

  #addTransitions(sources: readonly Position[], targets: readonly Position[]): void {
    for (const source of sources) {
      const outgoing = this.#outgoing.get(source.id) ?? [];
      for (const target of targets) {
        for (const existing of outgoing) {
          if (intervalsOverlap(existing.characters, target.characters)) {
            invalid();
          }
        }
        outgoing.push(target);
      }
      this.#outgoing.set(source.id, outgoing);
    }
  }

  #assertDisjoint(positions: readonly Position[]): void {
    for (let leftIndex = 0; leftIndex < positions.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < positions.length; rightIndex += 1) {
        if (intervalsOverlap(positions[leftIndex]!.characters, positions[rightIndex]!.characters)) {
          invalid();
        }
      }
    }
  }

  #peek(): string | undefined {
    return this.#pattern[this.#index];
  }

  #isQuantifierStart(character: string | undefined): boolean {
    return character === "?" || character === "*" || character === "+" || character === "{";
  }

  #isAsciiDigit(character: string | undefined): boolean {
    return character !== undefined && character >= "0" && character <= "9";
  }
}

export function assertPortablePattern(pattern: string): void {
  if (pattern.length > MAX_PATTERN_CODE_UNITS) {
    invalid();
  }

  new Parser(pattern).parse();
  try {
    new RegExp(pattern, "u");
  } catch {
    invalid();
  }
}
