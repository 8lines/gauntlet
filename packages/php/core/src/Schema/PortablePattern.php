<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Schema;

/** Exact parser for the bounded tc-schema-core@1 regular-expression subset. */
final class PortablePattern
{
    public static function assert(string $pattern): void
    {
        if (!mb_check_encoding($pattern, 'UTF-8')) {
            throw new \InvalidArgumentException('Pattern is not valid UTF-8.');
        }
        $utf16 = mb_convert_encoding($pattern, 'UTF-16BE', 'UTF-8');
        if (strlen($utf16) / 2 > 512) {
            throw new \InvalidArgumentException('Pattern exceeds 512 UTF-16 code units.');
        }

        (new PortablePatternParser($pattern))->parse();

        $expression = '~' . str_replace('~', '\\~', $pattern) . '~u';
        set_error_handler(static fn (): bool => true);
        try {
            if (preg_match($expression, '') === false) {
                throw new \InvalidArgumentException('Pattern cannot be compiled.');
            }
        } finally {
            restore_error_handler();
        }
    }
}

/** @internal */
final class PortablePatternParser
{
    private const UNBOUNDED = PHP_INT_MAX;
    private const HIGH_SURROGATE_START = 0xD800;
    private const HIGH_SURROGATE_END = 0xDBFF;
    private const LOW_SURROGATE_END = 0xDFFF;
    private const MAX_SCALAR = 0x10FFFF;

    /** @var list<array{0: int, 1: int}> */
    private const SCALAR_UNIVERSE = [
        [0, self::HIGH_SURROGATE_START - 1],
        [self::LOW_SURROGATE_END + 1, self::MAX_SCALAR],
    ];

    /** @var list<string> */
    private array $characters;

    /** @var array<int, list<array{id: int, characters: list<array{0: int, 1: int}>}>> */
    private array $outgoing = [];

    private bool $hasUnboundedQuantifier = false;
    private bool $rootHasAlternation = false;
    private int $index = 0;
    private int $nextPositionId = 0;

    public function __construct(private readonly string $pattern)
    {
        $characters = preg_split('//u', $pattern, -1, PREG_SPLIT_NO_EMPTY);
        if ($characters === false) {
            throw new \InvalidArgumentException('Pattern is invalid.');
        }
        $this->characters = $characters;
    }

    public function parse(): void
    {
        $expression = $this->parseDisjunction(true);
        if ($this->index !== count($this->characters)) {
            $this->invalid();
        }
        if ($this->hasUnboundedQuantifier
            && (($this->characters[0] ?? null) !== '^' || $this->rootHasAlternation)) {
            $this->invalid();
        }
        $this->assertDisjoint($expression['first']);
    }

    /**
     * @return array{nullable: int, first: list<array{id: int, characters: list<array{0: int, 1: int}>}>, last: list<array{id: int, characters: list<array{0: int, 1: int}>}>}
     */
    private function parseDisjunction(bool $root = false): array
    {
        $result = $this->parseAlternative();
        while ($this->peek() === '|') {
            if ($root) {
                $this->rootHasAlternation = true;
            }
            $this->index++;
            $result = $this->alternate($result, $this->parseAlternative());
        }

        return $result;
    }

    /** @return array{nullable: int, first: array, last: array} */
    private function parseAlternative(): array
    {
        $result = $this->emptyAnalysis();
        while ($this->index < count($this->characters)) {
            $character = $this->peek();
            if ($character === '|' || $character === ')') {
                break;
            }
            $result = $this->concatenate($result, $this->parseTerm());
        }

        return $result;
    }

    /** @return array{nullable: int, first: array, last: array} */
    private function parseTerm(): array
    {
        $character = $this->peek();
        if ($character === '^' || $character === '$') {
            $this->index++;
            if ($this->isQuantifierStart($this->peek())) {
                $this->invalid();
            }

            return $this->emptyAnalysis();
        }
        if ($character === null || $this->isQuantifierStart($character) || $character === '}') {
            $this->invalid();
        }

        $atom = $this->parseAtom();
        if ($this->isQuantifierStart($this->peek())) {
            $quantifier = $this->parseQuantifier();
            if ($quantifier['maximum'] === self::UNBOUNDED) {
                $this->hasUnboundedQuantifier = true;
            }
            $atom = $this->repeat($atom, $quantifier);
            if ($this->isQuantifierStart($this->peek())) {
                $this->invalid();
            }
        }

        return $atom;
    }

    /** @return array{nullable: int, first: array, last: array} */
    private function parseAtom(): array
    {
        $character = $this->peek();
        if ($character === '(') {
            $this->index++;
            if ($this->peek() === '?') {
                if (($this->characters[$this->index + 1] ?? null) !== ':') {
                    $this->invalid();
                }
                $this->index += 2;
            }
            $body = $this->parseDisjunction();
            if ($this->peek() !== ')') {
                $this->invalid();
            }
            $this->index++;

            return $body;
        }
        if ($character === '[') {
            return $this->parseClass();
        }
        if ($character === '\\') {
            $this->index++;
            $escaped = $this->peek();
            if ($escaped === null || !str_contains('\\^$.*+?()[]{}|/', $escaped)) {
                $this->invalid();
            }
            $this->index++;

            return $this->position(mb_ord($escaped, 'UTF-8'));
        }
        if ($character === null
            || in_array($character, ['.', ')', ']', '{', '|'], true)) {
            $this->invalid();
        }

        return $this->position($this->readRawScalar());
    }

    /** @return array{nullable: int, first: array, last: array} */
    private function parseClass(): array
    {
        $this->index++;
        $negated = $this->peek() === '^';
        if ($negated) {
            $this->index++;
        }

        $intervals = [];
        $itemCount = 0;
        while ($this->index < count($this->characters) && $this->peek() !== ']') {
            if (($this->peek() === '&' && ($this->characters[$this->index + 1] ?? null) === '&')
                || ($this->peek() === '-' && ($this->characters[$this->index + 1] ?? null) === '-')) {
                $this->invalid();
            }
            $start = $this->readClassScalar();
            $itemCount++;
            if ($this->peek() === '-' && ($this->characters[$this->index + 1] ?? null) !== ']') {
                if (($this->characters[$this->index + 1] ?? null) === '-') {
                    $this->invalid();
                }
                $this->index++;
                $end = $this->readClassScalar();
                if ($start > $end
                    || ($start < self::HIGH_SURROGATE_START && $end > self::LOW_SURROGATE_END)) {
                    $this->invalid();
                }
                $intervals[] = [$start, $end];
            } else {
                $intervals[] = [$start, $start];
            }
        }
        if ($this->peek() !== ']' || $itemCount === 0) {
            $this->invalid();
        }
        $this->index++;

        $characters = $negated
            ? $this->complementIntervals($intervals)
            : $this->normalizeIntervals($intervals);
        if ($characters === [] || $characters === self::SCALAR_UNIVERSE) {
            $this->invalid();
        }

        return $this->positionWithIntervals($characters);
    }

    private function readClassScalar(): int
    {
        $character = $this->peek();
        if ($character === null || $character === ']' || $character === '[') {
            $this->invalid();
        }
        if ($character === '\\') {
            $this->index++;
            $escaped = $this->peek();
            if ($escaped === null || !in_array($escaped, ['\\', ']', '^', '-'], true)) {
                $this->invalid();
            }
            $this->index++;

            return mb_ord($escaped, 'UTF-8');
        }

        return $this->readRawScalar();
    }

    private function readRawScalar(): int
    {
        $character = $this->peek();
        if ($character === null) {
            $this->invalid();
        }
        $this->index++;
        $codePoint = mb_ord($character, 'UTF-8');
        if ($codePoint <= 0x1F || ($codePoint >= 0x7F && $codePoint <= 0x9F)
            || ($codePoint >= self::HIGH_SURROGATE_START && $codePoint <= self::LOW_SURROGATE_END)) {
            $this->invalid();
        }

        return $codePoint;
    }

    /** @return array{minimum: int, maximum: int} */
    private function parseQuantifier(): array
    {
        $character = $this->peek();
        if ($character === '?') {
            $this->index++;

            return ['minimum' => 0, 'maximum' => 1];
        }
        if ($character === '*') {
            $this->index++;

            return ['minimum' => 0, 'maximum' => self::UNBOUNDED];
        }
        if ($character === '+') {
            $this->index++;

            return ['minimum' => 1, 'maximum' => self::UNBOUNDED];
        }
        if ($character !== '{') {
            $this->invalid();
        }

        $this->index++;
        $minimum = $this->parseBound();
        if ($this->peek() === '}') {
            $this->index++;

            return ['minimum' => $minimum, 'maximum' => $minimum];
        }
        if ($this->peek() !== ',') {
            $this->invalid();
        }
        $this->index++;
        if ($this->peek() === '}') {
            $this->index++;

            return ['minimum' => $minimum, 'maximum' => self::UNBOUNDED];
        }
        $maximum = $this->parseBound();
        if ($this->peek() !== '}' || $minimum > $maximum) {
            $this->invalid();
        }
        $this->index++;

        return ['minimum' => $minimum, 'maximum' => $maximum];
    }

    private function parseBound(): int
    {
        $start = $this->index;
        while (($character = $this->peek()) !== null && $character >= '0' && $character <= '9') {
            $this->index++;
        }
        if ($start === $this->index) {
            $this->invalid();
        }
        $text = implode('', array_slice($this->characters, $start, $this->index - $start));
        if ((strlen($text) > 1 && str_starts_with($text, '0')) || strlen($text) > 4) {
            $this->invalid();
        }
        $value = (int) $text;
        if ($value > 1000) {
            $this->invalid();
        }

        return $value;
    }

    /** @return array{nullable: int, first: array, last: array} */
    private function position(int $codePoint): array
    {
        return $this->positionWithIntervals([[$codePoint, $codePoint]]);
    }

    /** @param list<array{0: int, 1: int}> $characters */
    private function positionWithIntervals(array $characters): array
    {
        $position = ['id' => $this->nextPositionId++, 'characters' => $characters];

        return ['nullable' => 0, 'first' => [$position], 'last' => [$position]];
    }

    /** @param array{nullable:int,first:array,last:array} $left @param array{nullable:int,first:array,last:array} $right */
    private function alternate(array $left, array $right): array
    {
        $nullable = $left['nullable'] + $right['nullable'];
        if ($nullable > 1) {
            $this->invalid();
        }

        return [
            'nullable' => $nullable,
            'first' => $this->unionPositions($left['first'], $right['first']),
            'last' => $this->unionPositions($left['last'], $right['last']),
        ];
    }

    /** @param array{nullable:int,first:array,last:array} $left @param array{nullable:int,first:array,last:array} $right */
    private function concatenate(array $left, array $right): array
    {
        $this->addTransitions($left['last'], $right['first']);
        $nullable = $left['nullable'] * $right['nullable'];
        if ($nullable > 1) {
            $this->invalid();
        }

        return [
            'nullable' => $nullable,
            'first' => $left['nullable'] > 0
                ? $this->unionPositions($left['first'], $right['first'])
                : $left['first'],
            'last' => $right['nullable'] > 0
                ? $this->unionPositions($left['last'], $right['last'])
                : $right['last'],
        ];
    }

    /** @param array{nullable:int,first:array,last:array} $body @param array{minimum:int,maximum:int} $quantifier */
    private function repeat(array $body, array $quantifier): array
    {
        if ($quantifier['maximum'] === 0) {
            return $this->emptyAnalysis();
        }
        if ($quantifier['maximum'] > 1) {
            if ($body['nullable'] > 0) {
                $this->invalid();
            }
            $this->addTransitions($body['last'], $body['first']);
        } elseif ($quantifier['minimum'] === 0 && $body['nullable'] > 0) {
            $this->invalid();
        }

        return [
            'nullable' => $quantifier['minimum'] === 0 ? 1 : $body['nullable'],
            'first' => $body['first'],
            'last' => $body['last'],
        ];
    }

    /** @param list<array{id:int,characters:array}> $sources @param list<array{id:int,characters:array}> $targets */
    private function addTransitions(array $sources, array $targets): void
    {
        foreach ($sources as $source) {
            $outgoing = $this->outgoing[$source['id']] ?? [];
            foreach ($targets as $target) {
                foreach ($outgoing as $existing) {
                    if ($this->intervalsOverlap($existing['characters'], $target['characters'])) {
                        $this->invalid();
                    }
                }
                $outgoing[] = $target;
            }
            $this->outgoing[$source['id']] = $outgoing;
        }
    }

    /** @param list<array{id:int,characters:array}> $positions */
    private function assertDisjoint(array $positions): void
    {
        $count = count($positions);
        for ($left = 0; $left < $count; $left++) {
            for ($right = $left + 1; $right < $count; $right++) {
                if ($this->intervalsOverlap($positions[$left]['characters'], $positions[$right]['characters'])) {
                    $this->invalid();
                }
            }
        }
    }

    /** @param list<array{id:int,characters:array}> $left @param list<array{id:int,characters:array}> $right */
    private function unionPositions(array $left, array $right): array
    {
        $result = $left;
        $seen = array_fill_keys(array_column($left, 'id'), true);
        foreach ($right as $position) {
            if (!isset($seen[$position['id']])) {
                $result[] = $position;
                $seen[$position['id']] = true;
            }
        }

        return $result;
    }

    /** @param list<array{0:int,1:int}> $intervals @return list<array{0:int,1:int}> */
    private function normalizeIntervals(array $intervals): array
    {
        usort($intervals, static fn (array $left, array $right): int => $left[0] <=> $right[0] ?: $left[1] <=> $right[1]);
        $result = [];
        foreach ($intervals as [$start, $end]) {
            $last = array_key_last($result);
            if ($last === null || $start > $result[$last][1] + 1) {
                $result[] = [$start, $end];
            } else {
                $result[$last][1] = max($result[$last][1], $end);
            }
        }

        return $result;
    }

    /** @param list<array{0:int,1:int}> $intervals @return list<array{0:int,1:int}> */
    private function complementIntervals(array $intervals): array
    {
        $excluded = $this->normalizeIntervals($intervals);
        $result = [];
        foreach (self::SCALAR_UNIVERSE as [$universeStart, $universeEnd]) {
            $cursor = $universeStart;
            foreach ($excluded as [$excludedStart, $excludedEnd]) {
                if ($excludedEnd < $cursor || $excludedStart > $universeEnd) {
                    continue;
                }
                if ($excludedStart > $cursor) {
                    $result[] = [$cursor, min($excludedStart - 1, $universeEnd)];
                }
                $cursor = max($cursor, $excludedEnd + 1);
                if ($cursor > $universeEnd) {
                    break;
                }
            }
            if ($cursor <= $universeEnd) {
                $result[] = [$cursor, $universeEnd];
            }
        }

        return $result;
    }

    /** @param list<array{0:int,1:int}> $left @param list<array{0:int,1:int}> $right */
    private function intervalsOverlap(array $left, array $right): bool
    {
        $leftIndex = 0;
        $rightIndex = 0;
        while ($leftIndex < count($left) && $rightIndex < count($right)) {
            [$leftStart, $leftEnd] = $left[$leftIndex];
            [$rightStart, $rightEnd] = $right[$rightIndex];
            if ($leftEnd < $rightStart) {
                $leftIndex++;
            } elseif ($rightEnd < $leftStart) {
                $rightIndex++;
            } else {
                return true;
            }
        }

        return false;
    }

    /** @return array{nullable:int,first:array,last:array} */
    private function emptyAnalysis(): array
    {
        return ['nullable' => 1, 'first' => [], 'last' => []];
    }

    private function peek(): ?string
    {
        return $this->characters[$this->index] ?? null;
    }

    private function isQuantifierStart(?string $character): bool
    {
        return in_array($character, ['?', '*', '+', '{'], true);
    }

    private function invalid(): never
    {
        throw new \InvalidArgumentException('Pattern is not in the tc-schema-core@1 portable profile.');
    }
}
