package dev.eightlines.gauntlet.core.schema;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/** Parser and determinism gate for the frozen {@code tc-schema-core@1} pattern subset. */
final class PortablePattern {
  private static final int MAX_PATTERN_CODE_UNITS = 512;
  private static final int MAX_QUANTIFIER_BOUND = 1_000;
  private static final int UNBOUNDED = Integer.MAX_VALUE;
  private static final int HIGH_SURROGATE_START = 0xd800;
  private static final int HIGH_SURROGATE_END = 0xdbff;
  private static final int LOW_SURROGATE_START = 0xdc00;
  private static final int LOW_SURROGATE_END = 0xdfff;
  private static final int MAX_SCALAR = 0x10ffff;
  private static final List<Interval> SCALAR_UNIVERSE =
      List.of(
          new Interval(0, HIGH_SURROGATE_START - 1),
          new Interval(LOW_SURROGATE_END + 1, MAX_SCALAR));
  private static final Set<Character> EXTERNAL_ESCAPES = characters("\\^$.*+?()[]{}|/");
  private static final Set<Character> CLASS_ESCAPES = Set.of('\\', ']', '^', '-');
  private static final Analysis EMPTY = new Analysis(1, List.of(), List.of());

  private PortablePattern() {}

  static void assertValid(String pattern) {
    if (pattern == null || pattern.length() > MAX_PATTERN_CODE_UNITS) {
      throw invalid();
    }
    new Parser(pattern).parse();
    try {
      Pattern.compile(pattern);
    } catch (PatternSyntaxException exception) {
      throw invalid();
    }
  }

  static boolean matches(String pattern, String value) {
    assertValid(pattern);
    return Pattern.compile(toJavaRegularExpression(pattern)).matcher(value).find();
  }

  /** Java's {@code $} also accepts the position before a final line terminator; ES does not. */
  private static String toJavaRegularExpression(String pattern) {
    StringBuilder translated = new StringBuilder(pattern.length());
    boolean escaped = false;
    boolean characterClass = false;
    for (int index = 0; index < pattern.length(); index++) {
      char character = pattern.charAt(index);
      if (escaped) {
        translated.append(character);
        escaped = false;
      } else if (character == '\\') {
        translated.append(character);
        escaped = true;
      } else if (character == '[') {
        translated.append(character);
        characterClass = true;
      } else if (character == ']' && characterClass) {
        translated.append(character);
        characterClass = false;
      } else if (character == '$' && !characterClass) {
        translated.append("\\z");
      } else {
        translated.append(character);
      }
    }
    return translated.toString();
  }

  private static Set<Character> characters(String value) {
    Set<Character> result = new HashSet<>();
    for (int index = 0; index < value.length(); index++) {
      result.add(value.charAt(index));
    }
    return Set.copyOf(result);
  }

  private static IllegalArgumentException invalid() {
    return new IllegalArgumentException("invalid portable pattern");
  }

  private static boolean isControl(int codePoint) {
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  }

  private static boolean isHighSurrogate(int codeUnit) {
    return codeUnit >= HIGH_SURROGATE_START && codeUnit <= HIGH_SURROGATE_END;
  }

  private static boolean isLowSurrogate(int codeUnit) {
    return codeUnit >= LOW_SURROGATE_START && codeUnit <= LOW_SURROGATE_END;
  }

  private static List<Position> unionPositions(List<Position> left, List<Position> right) {
    if (left.isEmpty()) {
      return right;
    }
    if (right.isEmpty()) {
      return left;
    }
    List<Position> result = new ArrayList<>(left);
    Set<Integer> seen = new HashSet<>();
    left.forEach(position -> seen.add(position.id()));
    for (Position position : right) {
      if (seen.add(position.id())) {
        result.add(position);
      }
    }
    return List.copyOf(result);
  }

  private static List<Interval> normalizeIntervals(List<Interval> intervals) {
    List<Interval> sorted = new ArrayList<>(intervals);
    sorted.sort(Comparator.comparingInt(Interval::start).thenComparingInt(Interval::end));
    List<Interval> result = new ArrayList<>();
    for (Interval interval : sorted) {
      if (result.isEmpty()) {
        result.add(interval);
        continue;
      }
      Interval previous = result.getLast();
      if (interval.start() > previous.end() + 1) {
        result.add(interval);
      } else {
        result.set(
            result.size() - 1,
            new Interval(previous.start(), Math.max(previous.end(), interval.end())));
      }
    }
    return List.copyOf(result);
  }

  private static List<Interval> complementIntervals(List<Interval> intervals) {
    List<Interval> excluded = normalizeIntervals(intervals);
    List<Interval> result = new ArrayList<>();
    for (Interval universe : SCALAR_UNIVERSE) {
      int cursor = universe.start();
      for (Interval interval : excluded) {
        if (interval.end() < cursor || interval.start() > universe.end()) {
          continue;
        }
        if (interval.start() > cursor) {
          result.add(new Interval(cursor, Math.min(interval.start() - 1, universe.end())));
        }
        cursor = Math.max(cursor, interval.end() + 1);
        if (cursor > universe.end()) {
          break;
        }
      }
      if (cursor <= universe.end()) {
        result.add(new Interval(cursor, universe.end()));
      }
    }
    return List.copyOf(result);
  }

  private static boolean intervalsOverlap(List<Interval> left, List<Interval> right) {
    int leftIndex = 0;
    int rightIndex = 0;
    while (leftIndex < left.size() && rightIndex < right.size()) {
      Interval leftInterval = left.get(leftIndex);
      Interval rightInterval = right.get(rightIndex);
      if (leftInterval.end() < rightInterval.start()) {
        leftIndex++;
      } else if (rightInterval.end() < leftInterval.start()) {
        rightIndex++;
      } else {
        return true;
      }
    }
    return false;
  }

  private static boolean isScalarUniverse(List<Interval> intervals) {
    return intervals.equals(SCALAR_UNIVERSE);
  }

  private record Interval(int start, int end) {}

  private record Position(int id, List<Interval> characters) {}

  private record Analysis(int nullableDerivations, List<Position> first, List<Position> last) {}

  private record Quantifier(int minimum, int maximum) {}

  private static final class Parser {
    private final String pattern;
    private final Map<Integer, List<Position>> outgoing = new HashMap<>();
    private boolean hasUnboundedQuantifier;
    private int index;
    private int nextPositionId;
    private boolean rootHasAlternation;

    private Parser(String pattern) {
      this.pattern = pattern;
    }

    private void parse() {
      Analysis expression = parseDisjunction(true);
      if (index != pattern.length()) {
        throw invalid();
      }
      if (hasUnboundedQuantifier
          && (pattern.isEmpty() || pattern.charAt(0) != '^' || rootHasAlternation)) {
        throw invalid();
      }
      assertDisjoint(expression.first());
    }

    private Analysis parseDisjunction(boolean root) {
      Analysis result = parseAlternative();
      while (peek() == '|') {
        if (root) {
          rootHasAlternation = true;
        }
        index++;
        result = alternate(result, parseAlternative());
      }
      return result;
    }

    private Analysis parseAlternative() {
      Analysis result = EMPTY;
      while (index < pattern.length()) {
        char character = peek();
        if (character == '|' || character == ')') {
          break;
        }
        result = concatenate(result, parseTerm());
      }
      return result;
    }

    private Analysis parseTerm() {
      char character = peek();
      if (character == '^' || character == '$') {
        index++;
        if (isQuantifierStart(peek())) {
          throw invalid();
        }
        return EMPTY;
      }
      if (character == '\0' || isQuantifierStart(character) || character == '}') {
        throw invalid();
      }
      Analysis atom = parseAtom();
      if (isQuantifierStart(peek())) {
        Quantifier quantifier = parseQuantifier();
        if (quantifier.maximum() == UNBOUNDED) {
          hasUnboundedQuantifier = true;
        }
        atom = repeat(atom, quantifier);
        if (isQuantifierStart(peek())) {
          throw invalid();
        }
      }
      return atom;
    }

    private Analysis parseAtom() {
      char character = peek();
      if (character == '(') {
        index++;
        if (peek() == '?') {
          if (charAt(index + 1) != ':') {
            throw invalid();
          }
          index += 2;
        }
        Analysis body = parseDisjunction(false);
        if (peek() != ')') {
          throw invalid();
        }
        index++;
        return body;
      }
      if (character == '[') {
        return parseClass();
      }
      if (character == '\\') {
        index++;
        char escaped = peek();
        if (escaped == '\0' || !EXTERNAL_ESCAPES.contains(escaped)) {
          throw invalid();
        }
        index++;
        return position(escaped);
      }
      if (character == '\0'
          || character == '.'
          || character == ')'
          || character == ']'
          || character == '{'
          || character == '|') {
        throw invalid();
      }
      return position(readRawScalar());
    }

    private Analysis parseClass() {
      index++;
      boolean negated = peek() == '^';
      if (negated) {
        index++;
      }
      List<Interval> intervals = new ArrayList<>();
      int itemCount = 0;
      while (index < pattern.length() && peek() != ']') {
        if (pattern.startsWith("&&", index) || pattern.startsWith("--", index)) {
          throw invalid();
        }
        int start = readClassScalar();
        itemCount++;
        if (peek() == '-' && charAt(index + 1) != ']') {
          if (charAt(index + 1) == '-') {
            throw invalid();
          }
          index++;
          int end = readClassScalar();
          if (start > end || (start < HIGH_SURROGATE_START && end > LOW_SURROGATE_END)) {
            throw invalid();
          }
          intervals.add(new Interval(start, end));
        } else {
          intervals.add(new Interval(start, start));
        }
      }
      if (peek() != ']' || itemCount == 0) {
        throw invalid();
      }
      index++;
      List<Interval> characters =
          negated ? complementIntervals(intervals) : normalizeIntervals(intervals);
      if (characters.isEmpty() || isScalarUniverse(characters)) {
        throw invalid();
      }
      return positionWithIntervals(characters);
    }

    private int readClassScalar() {
      char character = peek();
      if (character == '\0' || character == ']' || character == '[') {
        throw invalid();
      }
      if (character == '\\') {
        index++;
        char escaped = peek();
        if (escaped == '\0' || !CLASS_ESCAPES.contains(escaped)) {
          throw invalid();
        }
        index++;
        return escaped;
      }
      return readRawScalar();
    }

    private int readRawScalar() {
      if (index >= pattern.length()) {
        throw invalid();
      }
      int first = pattern.charAt(index);
      int codePoint = first;
      if (isHighSurrogate(first)) {
        int second = charAt(index + 1);
        if (!isLowSurrogate(second)) {
          throw invalid();
        }
        codePoint =
            ((first - HIGH_SURROGATE_START) * 0x400) + (second - LOW_SURROGATE_START) + 0x10000;
        index += 2;
      } else {
        if (isLowSurrogate(first)) {
          throw invalid();
        }
        index++;
      }
      if (isControl(codePoint)) {
        throw invalid();
      }
      return codePoint;
    }

    private Quantifier parseQuantifier() {
      char character = peek();
      if (character == '?') {
        index++;
        return new Quantifier(0, 1);
      }
      if (character == '*') {
        index++;
        return new Quantifier(0, UNBOUNDED);
      }
      if (character == '+') {
        index++;
        return new Quantifier(1, UNBOUNDED);
      }
      if (character != '{') {
        throw invalid();
      }
      index++;
      int minimum = parseBound();
      if (peek() == '}') {
        index++;
        return new Quantifier(minimum, minimum);
      }
      if (peek() != ',') {
        throw invalid();
      }
      index++;
      if (peek() == '}') {
        index++;
        return new Quantifier(minimum, UNBOUNDED);
      }
      int maximum = parseBound();
      if (peek() != '}' || minimum > maximum) {
        throw invalid();
      }
      index++;
      return new Quantifier(minimum, maximum);
    }

    private int parseBound() {
      int start = index;
      while (isAsciiDigit(peek())) {
        index++;
      }
      if (start == index) {
        throw invalid();
      }
      String text = pattern.substring(start, index);
      if ((text.length() > 1 && text.charAt(0) == '0') || text.length() > 4) {
        throw invalid();
      }
      int value = Integer.parseInt(text);
      if (value > MAX_QUANTIFIER_BOUND) {
        throw invalid();
      }
      return value;
    }

    private Analysis position(int codePoint) {
      return positionWithIntervals(List.of(new Interval(codePoint, codePoint)));
    }

    private Analysis positionWithIntervals(List<Interval> characters) {
      Position position = new Position(nextPositionId++, characters);
      return new Analysis(0, List.of(position), List.of(position));
    }

    private Analysis alternate(Analysis left, Analysis right) {
      int nullable = left.nullableDerivations() + right.nullableDerivations();
      if (nullable > 1) {
        throw invalid();
      }
      return new Analysis(
          nullable,
          unionPositions(left.first(), right.first()),
          unionPositions(left.last(), right.last()));
    }

    private Analysis concatenate(Analysis left, Analysis right) {
      addTransitions(left.last(), right.first());
      int nullable = left.nullableDerivations() * right.nullableDerivations();
      if (nullable > 1) {
        throw invalid();
      }
      return new Analysis(
          nullable,
          left.nullableDerivations() > 0
              ? unionPositions(left.first(), right.first())
              : left.first(),
          right.nullableDerivations() > 0
              ? unionPositions(left.last(), right.last())
              : right.last());
    }

    private Analysis repeat(Analysis body, Quantifier quantifier) {
      if (quantifier.maximum() == 0) {
        return EMPTY;
      }
      if (quantifier.maximum() > 1) {
        if (body.nullableDerivations() > 0) {
          throw invalid();
        }
        addTransitions(body.last(), body.first());
      } else if (quantifier.minimum() == 0 && body.nullableDerivations() > 0) {
        throw invalid();
      }
      return new Analysis(
          quantifier.minimum() == 0 ? 1 : body.nullableDerivations(), body.first(), body.last());
    }

    private void addTransitions(List<Position> sources, List<Position> targets) {
      for (Position source : sources) {
        List<Position> transitions =
            outgoing.computeIfAbsent(source.id(), ignored -> new ArrayList<>());
        for (Position target : targets) {
          for (Position existing : transitions) {
            if (intervalsOverlap(existing.characters(), target.characters())) {
              throw invalid();
            }
          }
          transitions.add(target);
        }
      }
    }

    private void assertDisjoint(List<Position> positions) {
      for (int left = 0; left < positions.size(); left++) {
        for (int right = left + 1; right < positions.size(); right++) {
          if (intervalsOverlap(
              positions.get(left).characters(), positions.get(right).characters())) {
            throw invalid();
          }
        }
      }
    }

    private char peek() {
      return charAt(index);
    }

    private char charAt(int position) {
      return position >= 0 && position < pattern.length() ? pattern.charAt(position) : '\0';
    }

    private boolean isQuantifierStart(char character) {
      return character == '?' || character == '*' || character == '+' || character == '{';
    }

    private boolean isAsciiDigit(char character) {
      return character >= '0' && character <= '9';
    }
  }
}
