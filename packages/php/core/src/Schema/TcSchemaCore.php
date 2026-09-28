<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Schema;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use Opis\JsonSchema\CompliantValidator;

/** Validates the portable tc-schema-core@1 subset of Draft 2020-12. */
final class TcSchemaCore
{
    public const DIALECT = 'https://json-schema.org/draft/2020-12/schema';

    /** @var array<string, true> */
    private const ALLOWED_KEYWORDS = [
        '$schema' => true,
        '$ref' => true,
        '$defs' => true,
        '$comment' => true,
        'type' => true,
        'enum' => true,
        'const' => true,
        'multipleOf' => true,
        'maximum' => true,
        'exclusiveMaximum' => true,
        'minimum' => true,
        'exclusiveMinimum' => true,
        'maxLength' => true,
        'minLength' => true,
        'pattern' => true,
        'format' => true,
        'maxItems' => true,
        'minItems' => true,
        'uniqueItems' => true,
        'maxContains' => true,
        'minContains' => true,
        'maxProperties' => true,
        'minProperties' => true,
        'required' => true,
        'dependentRequired' => true,
        'allOf' => true,
        'anyOf' => true,
        'oneOf' => true,
        'not' => true,
        'if' => true,
        'then' => true,
        'else' => true,
        'dependentSchemas' => true,
        'prefixItems' => true,
        'items' => true,
        'contains' => true,
        'properties' => true,
        'patternProperties' => true,
        'additionalProperties' => true,
        'propertyNames' => true,
        'unevaluatedItems' => true,
        'unevaluatedProperties' => true,
        'title' => true,
        'description' => true,
        'default' => true,
        'deprecated' => true,
        'readOnly' => true,
        'writeOnly' => true,
        'examples' => true,
        'contentEncoding' => true,
        'contentMediaType' => true,
        'contentSchema' => true,
    ];

    /** @var array<string, true> */
    private const ALLOWED_FORMATS = [
        'date' => true,
        'date-time' => true,
        'email' => true,
        'hostname' => true,
        'ipv4' => true,
        'ipv6' => true,
        'uri' => true,
        'uuid' => true,
    ];

    private const SCHEMA_MAP_KEYWORDS = ['$defs', 'dependentSchemas', 'properties', 'patternProperties'];
    private const SCHEMA_ARRAY_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
    private const SCHEMA_KEYWORDS = [
        'not',
        'if',
        'then',
        'else',
        'items',
        'contains',
        'additionalProperties',
        'propertyNames',
        'unevaluatedItems',
        'unevaluatedProperties',
        'contentSchema',
    ];
    private const SAME_INSTANCE_MAP_KEYWORDS = ['dependentSchemas'];
    private const SAME_INSTANCE_ARRAY_KEYWORDS = ['allOf', 'anyOf', 'oneOf'];
    private const SAME_INSTANCE_KEYWORDS = ['not', 'if', 'then', 'else'];

    public static function assert(JsonObject $schema, bool $requireObjectRoot = false): void
    {
        $root = JsonOwnership::transport(JsonOwnership::own($schema));
        if (!$root instanceof \stdClass) {
            self::fail('', 'schema root must be an object');
        }
        if (!property_exists($root, '$schema') || $root->{'$schema'} !== self::DIALECT) {
            self::fail('/$schema', 'root schema has an unsupported dialect');
        }
        if ($requireObjectRoot && (!property_exists($root, 'type') || $root->type !== 'object')) {
            self::fail('/type', 'root schema type must be object');
        }

        /** @var array<string, \stdClass|bool> $nodes */
        $nodes = [];
        /** @var list<array{source:string,reference:string,pointer:string}> $references */
        $references = [];
        /** @var array<string, array<string, true>> $sameInstanceEdges */
        $sameInstanceEdges = [];
        $pending = [['node' => $root, 'pointer' => '']];

        while ($pending !== []) {
            $current = array_pop($pending);
            $node = $current['node'];
            $pointer = $current['pointer'];
            if (isset($nodes[$pointer])) {
                continue;
            }
            if (!is_bool($node) && !$node instanceof \stdClass) {
                self::fail($pointer, 'schema must be a boolean or object');
            }
            $nodes[$pointer] = $node;
            if (is_bool($node)) {
                continue;
            }

            foreach (get_object_vars($node) as $keyword => $value) {
                if (!isset(self::ALLOWED_KEYWORDS[$keyword])) {
                    self::fail(self::childPointer($pointer, $keyword), 'unsupported schema keyword');
                }
            }

            if (property_exists($node, '$ref')) {
                if (!is_string($node->{'$ref'}) || !str_starts_with($node->{'$ref'}, '#')) {
                    self::fail(self::childPointer($pointer, '$ref'), 'only local fragment references are supported');
                }
                $references[] = [
                    'source' => $pointer,
                    'reference' => $node->{'$ref'},
                    'pointer' => self::childPointer($pointer, '$ref'),
                ];
            }
            if (property_exists($node, 'format')
                && (!is_string($node->format) || !isset(self::ALLOWED_FORMATS[$node->format]))) {
                self::fail(self::childPointer($pointer, 'format'), 'unsupported schema format');
            }
            if (property_exists($node, 'pattern')) {
                if (!is_string($node->pattern)) {
                    self::fail(self::childPointer($pointer, 'pattern'), 'pattern must be a string');
                }
                PortablePattern::assert($node->pattern);
            }

            foreach (self::SCHEMA_MAP_KEYWORDS as $keyword) {
                if (!property_exists($node, $keyword)) {
                    continue;
                }
                $map = $node->{$keyword};
                if (!$map instanceof \stdClass) {
                    self::fail(self::childPointer($pointer, $keyword), $keyword . ' must be an object');
                }
                foreach (get_object_vars($map) as $key => $child) {
                    if ($keyword === 'patternProperties') {
                        PortablePattern::assert($key);
                    }
                    $childPointer = self::childPointer(self::childPointer($pointer, $keyword), $key);
                    self::queueSchema($pending, $child, $childPointer);
                    if (in_array($keyword, self::SAME_INSTANCE_MAP_KEYWORDS, true)) {
                        $sameInstanceEdges[$pointer][$childPointer] = true;
                    }
                }
            }

            foreach (self::SCHEMA_ARRAY_KEYWORDS as $keyword) {
                if (!property_exists($node, $keyword)) {
                    continue;
                }
                $children = $node->{$keyword};
                if (!is_array($children)) {
                    self::fail(self::childPointer($pointer, $keyword), $keyword . ' must be an array');
                }
                foreach ($children as $index => $child) {
                    $childPointer = self::childPointer(self::childPointer($pointer, $keyword), (string) $index);
                    self::queueSchema($pending, $child, $childPointer);
                    if (in_array($keyword, self::SAME_INSTANCE_ARRAY_KEYWORDS, true)) {
                        $sameInstanceEdges[$pointer][$childPointer] = true;
                    }
                }
            }

            foreach (self::SCHEMA_KEYWORDS as $keyword) {
                if (!property_exists($node, $keyword)) {
                    continue;
                }
                $childPointer = self::childPointer($pointer, $keyword);
                self::queueSchema($pending, $node->{$keyword}, $childPointer);
                if (in_array($keyword, self::SAME_INSTANCE_KEYWORDS, true)) {
                    $sameInstanceEdges[$pointer][$childPointer] = true;
                }
            }
        }

        foreach ($references as $reference) {
            $target = self::resolveLocalReferencePointer($root, $reference['reference']);
            if ($target === null || !array_key_exists($target, $nodes)) {
                self::fail($reference['pointer'], 'local reference cannot be resolved');
            }
            if (self::reaches($sameInstanceEdges, $target, $reference['source'])) {
                self::fail($reference['pointer'], 'non-productive same-instance reference cycle');
            }
            $sameInstanceEdges[$reference['source']][$target] = true;
        }

        // Parsing through CompliantValidator validates every Draft 2020-12
        // keyword shape while disabling Opis filters, casting, mappers, $data,
        // pragmas, templates, slots, and relative JSON pointers.
        try {
            (new CompliantValidator())->loader()->loadObjectSchema($root);
        } catch (\Throwable) {
            self::fail('', 'invalid Draft 2020-12 schema');
        }
    }

    /** @param list<array{node:mixed,pointer:string}> $pending */
    private static function queueSchema(array &$pending, mixed $node, string $pointer): void
    {
        if (!is_bool($node) && !$node instanceof \stdClass) {
            self::fail($pointer, 'schema must be a boolean or object');
        }
        $pending[] = ['node' => $node, 'pointer' => $pointer];
    }

    /** @param array<string, array<string, true>> $edges */
    private static function reaches(array $edges, string $start, string $destination): bool
    {
        $pending = [$start];
        $seen = [];
        while ($pending !== []) {
            $current = array_pop($pending);
            if ($current === $destination) {
                return true;
            }
            if (isset($seen[$current])) {
                continue;
            }
            $seen[$current] = true;
            foreach (array_keys($edges[$current] ?? []) as $target) {
                $pending[] = $target;
            }
        }

        return false;
    }

    private static function resolveLocalReferencePointer(\stdClass $root, string $reference): ?string
    {
        if ($reference === '#') {
            return '';
        }
        if (!str_starts_with($reference, '#/')) {
            return null;
        }
        $fragment = rawurldecode(substr($reference, 1));
        $segments = self::decodePointer($fragment);
        if ($segments === null) {
            return null;
        }

        $current = $root;
        $canonical = '';
        foreach ($segments as $segment) {
            if (!$current instanceof \stdClass || !property_exists($current, $segment)) {
                return null;
            }
            $current = $current->{$segment};
            $canonical = self::childPointer($canonical, $segment);
        }

        return is_bool($current) || $current instanceof \stdClass ? $canonical : null;
    }

    /** @return list<string>|null */
    private static function decodePointer(string $pointer): ?array
    {
        if ($pointer === '') {
            return [];
        }
        if (!str_starts_with($pointer, '/')) {
            return null;
        }
        $segments = [];
        foreach (explode('/', substr($pointer, 1)) as $encoded) {
            if (preg_match('/~(?:[^01]|$)/', $encoded) === 1) {
                return null;
            }
            $segments[] = str_replace(['~1', '~0'], ['/', '~'], $encoded);
        }

        return $segments;
    }

    private static function childPointer(string $pointer, string $segment): string
    {
        return $pointer . '/' . str_replace(['~', '/'], ['~0', '~1'], $segment);
    }

    private static function fail(string $pointer, string $message): never
    {
        throw new \InvalidArgumentException(sprintf('At %s: %s.', $pointer === '' ? '/' : $pointer, $message));
    }
}
