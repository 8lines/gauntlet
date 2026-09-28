<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Schema;

use EightLines\Gauntlet\Core\Protocol\ProtocolId;

/** Canonical operation placement rules shared by definitions and wire semantics. */
final class PlacementRules
{
    public const PROFILE = 'gauntlet-page-placements@1';
    private const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean'];

    /**
     * Keywords that make a schema node non-traversable / non-scalar: any
     * node owning one of these cannot be descended into (intermediate
     * segments) nor treated as a scalar leaf, mirroring
     * packages/protocol/src/placements.ts.
     */
    private const NON_TRAVERSABLE_KEYWORDS = ['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else'];

    /** @return list<string>|null */
    public static function decode(string $pointer): ?array
    {
        if ($pointer === '' || $pointer[0] !== '/') {
            return null;
        }
        $segments = [];
        foreach (explode('/', substr($pointer, 1)) as $raw) {
            if (preg_match('/~(?![01])/', $raw) === 1) {
                return null;
            }
            $segments[] = str_replace(['~1', '~0'], ['/', '~'], $raw);
        }

        return $segments;
    }

    public static function schemaPointer(string $inputPointer): ?string
    {
        $segments = self::decode($inputPointer);
        if ($segments === null) {
            return null;
        }

        return implode('', array_map(
            static fn (string $segment): string => '/properties/' . str_replace(['~', '/'], ['~0', '~1'], $segment),
            $segments,
        ));
    }

    /** @param list<string> $guardedSchemaPointers @param list<mixed> $placements */
    public static function areValid(mixed $inputSchema, array $guardedSchemaPointers, array $placements): bool
    {
        if ($placements === []) {
            return false;
        }
        $globals = 0;
        $subjectTypes = [];
        foreach ($placements as $placement) {
            if (!$placement instanceof \stdClass) {
                return false;
            }
            $kind = $placement->kind ?? null;
            if ($kind === 'global') {
                $globals++;
                continue;
            }
            $subjectType = $placement->subjectType ?? null;
            if ($kind !== 'subject' || !is_string($subjectType) || !ProtocolId::isValid($subjectType) || isset($subjectTypes[$subjectType])) {
                return false;
            }
            $subjectTypes[$subjectType] = true;
            $bindings = $placement->bindings ?? new \stdClass();
            if (!$bindings instanceof \stdClass) {
                return false;
            }
            foreach (get_object_vars($bindings) as $pointer => $key) {
                $pointer = (string) $pointer;
                $schemaPointer = self::schemaPointer($pointer);
                if (!is_string($key) || !ProtocolId::isValid($key) || $schemaPointer === null || !self::targetIsScalar($inputSchema, $pointer)) {
                    return false;
                }
                foreach ($guardedSchemaPointers as $guarded) {
                    if ($schemaPointer === $guarded || str_starts_with($schemaPointer, $guarded . '/')) {
                        return false;
                    }
                }
            }
        }

        return $globals <= 1;
    }

    private static function targetIsScalar(mixed $schema, string $pointer): bool
    {
        $node = $schema;
        if (!$node instanceof \stdClass || self::hasNonTraversableKeyword($node)) {
            return false;
        }
        foreach (self::decode($pointer) ?? [] as $segment) {
            $properties = $node->properties ?? null;
            if (!$properties instanceof \stdClass || !property_exists($properties, $segment)) {
                return false;
            }
            $node = $properties->{$segment};
            if (!$node instanceof \stdClass || self::hasNonTraversableKeyword($node)) {
                return false;
            }
        }
        if (property_exists($node, 'enum')) {
            return is_array($node->enum) && $node->enum !== [] && array_filter($node->enum, self::isScalar(...)) === $node->enum;
        }
        if (property_exists($node, 'const')) {
            return self::isScalar($node->const);
        }

        return is_string($node->type ?? null) && in_array($node->type, self::SCALAR_TYPES, true);
    }

    private static function hasNonTraversableKeyword(\stdClass $node): bool
    {
        foreach (self::NON_TRAVERSABLE_KEYWORDS as $keyword) {
            if (property_exists($node, $keyword)) {
                return true;
            }
        }

        return false;
    }

    private static function isScalar(mixed $value): bool
    {
        return is_string($value) || is_int($value) || is_float($value) || is_bool($value);
    }
}
