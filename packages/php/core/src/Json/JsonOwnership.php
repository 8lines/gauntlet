<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Json;

use ReflectionReference;
use SplObjectStorage;

/** Deep ownership boundary for protocol values and stored runtime state. */
final class JsonOwnership
{
    /** Root is depth zero; 0..510 gives the vendor's supported 511 containers. */
    private const MAX_CONTAINER_DEPTH = 510;
    private const MAX_SAFE_INTEGER = 9_007_199_254_740_991;

    /** @param array<array-key, mixed> $value */
    public static function object(array $value): JsonObject
    {
        $activeObjects = new SplObjectStorage();
        $activeReferences = [];

        return self::copyExplicitObject($value, 0, $activeObjects, $activeReferences);
    }

    /** @param list<mixed> $value */
    public static function list(array $value): JsonList
    {
        if (!array_is_list($value)) {
            throw CanonicalJsonException::invalidValue();
        }
        $activeObjects = new SplObjectStorage();
        $activeReferences = [];

        return self::copyList($value, 0, $activeObjects, $activeReferences);
    }

    /** Owns any legal JSON root while retaining its object/list/scalar shape. */
    public static function value(mixed $value): JsonValue
    {
        $owned = self::own($value);

        return $owned instanceof JsonValue ? $owned : new JsonScalar($owned);
    }

    public static function own(mixed $value): mixed
    {
        $activeObjects = new SplObjectStorage();
        $activeReferences = [];

        return self::copy($value, 0, $activeObjects, $activeReferences);
    }

    public static function fromJson(string $json): JsonObject|JsonList
    {
        try {
            $decoded = json_decode($json, false, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw CanonicalJsonException::invalidValue();
        }

        $owned = self::own($decoded);
        if (!$owned instanceof JsonObject && !$owned instanceof JsonList) {
            throw CanonicalJsonException::invalidValue();
        }

        return $owned;
    }

    /** Produces a fresh transport tree and revalidates every scalar. */
    public static function transport(mixed $value): mixed
    {
        if ($value instanceof JsonScalar) {
            $scalar = $value->value();
            self::assertScalar($scalar);

            return $scalar;
        }
        if ($value instanceof JsonObject) {
            $transport = new \stdClass();
            foreach ($value->entries() as [$key, $child]) {
                self::assertString($key);
                $transport->{$key} = self::transport($child);
            }

            return $transport;
        }
        if ($value instanceof JsonList) {
            return array_map(self::transport(...), $value->values());
        }

        self::assertScalar($value);

        return $value;
    }

    /** @param array<string, bool> $activeReferences */
    private static function copy(
        mixed &$value,
        int $depth,
        SplObjectStorage $activeObjects,
        array &$activeReferences,
    ): mixed {
        if ($value instanceof JsonScalar) {
            $scalar = $value->value();
            self::assertScalar($scalar);

            return new JsonScalar($scalar);
        }
        if ($value instanceof JsonObject) {
            self::assertDepth($depth);
            $entries = [];
            $seen = [];
            foreach ($value->entries() as [$key, $child]) {
                self::assertString($key);
                if (isset($seen[$key])) {
                    throw CanonicalJsonException::invalidValue();
                }
                $seen[$key] = true;
                $entries[] = [$key, self::copy($child, $depth + 1, $activeObjects, $activeReferences)];
            }

            return JsonObject::fromEntries($entries);
        }
        if ($value instanceof JsonList) {
            self::assertDepth($depth);
            $copy = [];
            foreach ($value->values() as $child) {
                $copy[] = self::copy($child, $depth + 1, $activeObjects, $activeReferences);
            }

            return new JsonList($copy);
        }
        if ($value instanceof \stdClass) {
            return self::copyStdClass($value, $depth, $activeObjects, $activeReferences);
        }
        if (is_array($value)) {
            if (array_is_list($value)) {
                return self::copyList($value, $depth, $activeObjects, $activeReferences);
            }
            foreach (array_keys($value) as $key) {
                if (!is_string($key)) {
                    throw CanonicalJsonException::invalidValue();
                }
            }

            return self::copyAssociativeObject($value, $depth, $activeObjects, $activeReferences);
        }

        self::assertScalar($value);

        return $value;
    }

    /**
     * @param array<array-key, mixed> $value
     * @param array<string, bool> $activeReferences
     */
    private static function copyExplicitObject(
        array &$value,
        int $depth,
        SplObjectStorage $activeObjects,
        array &$activeReferences,
    ): JsonObject {
        self::assertDepth($depth);
        $entries = [];
        foreach (array_keys($value) as $key) {
            $wireKey = (string) $key;
            self::assertString($wireKey);
            $entries[] = [
                $wireKey,
                self::copyArrayElement($value, $key, $depth + 1, $activeObjects, $activeReferences),
            ];
        }

        return JsonObject::fromEntries($entries);
    }

    /**
     * @param array<string, mixed> $value
     * @param array<string, bool> $activeReferences
     */
    private static function copyAssociativeObject(
        array &$value,
        int $depth,
        SplObjectStorage $activeObjects,
        array &$activeReferences,
    ): JsonObject {
        self::assertDepth($depth);
        $entries = [];
        foreach (array_keys($value) as $key) {
            self::assertString($key);
            $entries[] = [
                $key,
                self::copyArrayElement($value, $key, $depth + 1, $activeObjects, $activeReferences),
            ];
        }

        return JsonObject::fromEntries($entries);
    }

    /**
     * @param list<mixed> $value
     * @param array<string, bool> $activeReferences
     */
    private static function copyList(
        array &$value,
        int $depth,
        SplObjectStorage $activeObjects,
        array &$activeReferences,
    ): JsonList {
        self::assertDepth($depth);
        $copy = [];
        foreach (array_keys($value) as $key) {
            $copy[] = self::copyArrayElement($value, $key, $depth + 1, $activeObjects, $activeReferences);
        }

        return new JsonList($copy);
    }

    /**
     * @param array<array-key, mixed> $array
     * @param array<string, bool> $activeReferences
     */
    private static function copyArrayElement(
        array &$array,
        int|string $key,
        int $depth,
        SplObjectStorage $activeObjects,
        array &$activeReferences,
    ): mixed {
        $referenceId = ReflectionReference::fromArrayElement($array, $key)?->getId();
        if ($referenceId !== null) {
            $encodedId = bin2hex($referenceId);
            if (isset($activeReferences[$encodedId])) {
                throw CanonicalJsonException::invalidValue();
            }
            $activeReferences[$encodedId] = true;
        }

        try {
            $child = &$array[$key];

            return self::copy($child, $depth, $activeObjects, $activeReferences);
        } finally {
            if ($referenceId !== null) {
                unset($activeReferences[bin2hex($referenceId)]);
            }
        }
    }

    /** @param array<string, bool> $activeReferences */
    private static function copyStdClass(
        \stdClass $value,
        int $depth,
        SplObjectStorage $activeObjects,
        array &$activeReferences,
    ): JsonObject {
        self::assertDepth($depth);
        if ($activeObjects->offsetExists($value)) {
            throw CanonicalJsonException::invalidValue();
        }
        $activeObjects->offsetSet($value);

        try {
            $entries = [];
            foreach (get_object_vars($value) as $key => $child) {
                self::assertString($key);
                $entries[] = [$key, self::copy($child, $depth + 1, $activeObjects, $activeReferences)];
            }

            return JsonObject::fromEntries($entries);
        } finally {
            $activeObjects->offsetUnset($value);
        }
    }

    private static function assertDepth(int $depth): void
    {
        if ($depth > self::MAX_CONTAINER_DEPTH) {
            throw CanonicalJsonException::tooDeep();
        }
    }

    private static function assertScalar(mixed $value): void
    {
        if ($value === null || is_bool($value)) {
            return;
        }
        if (is_string($value)) {
            self::assertString($value);

            return;
        }
        if (is_int($value)) {
            if (abs($value) > self::MAX_SAFE_INTEGER) {
                throw CanonicalJsonException::invalidValue();
            }

            return;
        }
        if (is_float($value)) {
            if (!is_finite($value) || ($value === 0.0 && fdiv(1.0, $value) === -INF)) {
                throw CanonicalJsonException::invalidValue();
            }
            $absolute = abs($value);
            if (floor($value) === $value
                && $absolute > self::MAX_SAFE_INTEGER
                && $absolute < 1e21) {
                throw CanonicalJsonException::invalidValue();
            }

            return;
        }

        throw CanonicalJsonException::invalidValue();
    }

    private static function assertString(string $value): void
    {
        if (!mb_check_encoding($value, 'UTF-8')
            || preg_match('/\xED[\xA0-\xBF][\x80-\xBF]/', $value) === 1) {
            throw CanonicalJsonException::invalidValue();
        }
    }
}
