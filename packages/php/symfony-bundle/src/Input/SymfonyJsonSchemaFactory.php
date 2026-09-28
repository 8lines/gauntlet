<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Input;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Schema\TcSchemaCore;
use Symfony\Component\Validator\Constraint;
use Symfony\Component\Validator\Constraints as Assert;

final class SymfonyJsonSchemaFactory
{
    /**
     * @param class-string $class
     * @param array<string, 'string'|'integer'|'number'|'boolean'> $listItemTypes
     */
    public function forClass(string $class, array $listItemTypes = []): JsonObject
    {
        if (!class_exists($class)) {
            throw new UnsupportedInputShapeException('Input DTO class does not exist.');
        }

        $reflection = new \ReflectionClass($class);
        $constructor = $reflection->getConstructor();
        if ($constructor === null || !$constructor->isPublic()) {
            throw new UnsupportedInputShapeException('Input DTO needs a public constructor.');
        }

        $properties = [];
        $required = [];
        foreach ($constructor->getParameters() as $parameter) {
            if (!$parameter->isPromoted()) {
                throw new UnsupportedInputShapeException('Every input constructor parameter must be promoted.');
            }
            $properties[$parameter->getName()] = $this->propertySchema(
                $parameter,
                $reflection->getProperty($parameter->getName()),
                $listItemTypes[$parameter->getName()] ?? null,
            );
            if (!$parameter->isDefaultValueAvailable()) {
                $required[] = $parameter->getName();
            }
        }

        foreach (array_keys($listItemTypes) as $property) {
            if (!array_key_exists($property, $properties)) {
                throw new UnsupportedInputShapeException('List metadata names an unknown property.');
            }
        }

        $schema = [
            '$schema' => TcSchemaCore::DIALECT,
            'type' => 'object',
            'properties' => $properties,
            'additionalProperties' => false,
        ];
        if ($required !== []) {
            $schema['required'] = $required;
        }

        $owned = JsonOwnership::object($schema);
        TcSchemaCore::assert($owned, true);

        return $owned;
    }

    /**
     * @param 'string'|'integer'|'number'|'boolean'|null $listItemType
     * @return array<string, mixed>
     */
    private function propertySchema(
        \ReflectionParameter $parameter,
        \ReflectionProperty $property,
        ?string $listItemType,
    ): array {
        [$type, $nullable] = $this->parameterType($parameter->getType());
        $jsonType = match ($type) {
            'string' => 'string',
            'int' => 'integer',
            'float' => 'number',
            'bool' => 'boolean',
            'array' => 'array',
            default => throw new UnsupportedInputShapeException('Unsupported DTO property type.'),
        };
        $schema = ['type' => $nullable ? [$jsonType, 'null'] : $jsonType];

        if ($jsonType === 'array') {
            if ($listItemType === null) {
                throw new UnsupportedInputShapeException('List item type metadata is required.');
            }
            $schema['items'] = ['type' => $listItemType];
        } elseif ($listItemType !== null) {
            throw new UnsupportedInputShapeException('List metadata requires an array property.');
        }

        foreach ($property->getAttributes(Constraint::class, \ReflectionAttribute::IS_INSTANCEOF) as $attribute) {
            $constraint = $attribute->newInstance();
            match (true) {
                $constraint instanceof Assert\NotBlank => $this->applyNotBlank($schema, $jsonType),
                $constraint instanceof Assert\Length => $this->applyLength($schema, $constraint, $jsonType),
                $constraint instanceof Assert\Regex => $this->applyRegex($schema, $constraint, $jsonType),
                $constraint instanceof Assert\Uuid => $this->applyUuid($schema, $jsonType),
                $constraint instanceof Assert\Choice => $this->applyChoice($schema, $constraint),
                default => throw new UnsupportedInputShapeException('Unsupported Validator constraint.'),
            };
        }

        return $schema;
    }

    /** @return array{string, bool} */
    private function parameterType(?\ReflectionType $type): array
    {
        if ($type instanceof \ReflectionNamedType) {
            return [$type->getName(), $type->allowsNull()];
        }
        if ($type instanceof \ReflectionUnionType) {
            $names = [];
            $nullable = false;
            foreach ($type->getTypes() as $member) {
                if ($member->getName() === 'null') {
                    $nullable = true;
                } else {
                    $names[] = $member->getName();
                }
            }
            if (count($names) === 1) {
                return [$names[0], $nullable];
            }
        }

        throw new UnsupportedInputShapeException('Unsupported DTO property union.');
    }

    /** @param array<string, mixed> $schema */
    private function applyNotBlank(array &$schema, string $type): void
    {
        if ($type !== 'string') {
            throw new UnsupportedInputShapeException('NotBlank is portable only for strings.');
        }
        $schema['minLength'] = max(1, (int) ($schema['minLength'] ?? 0));
    }

    /** @param array<string, mixed> $schema */
    private function applyLength(array &$schema, Assert\Length $constraint, string $type): void
    {
        if ($type !== 'string') {
            throw new UnsupportedInputShapeException('Length is portable only for strings.');
        }
        if ($constraint->min !== null) {
            $schema['minLength'] = $constraint->min;
        }
        if ($constraint->max !== null) {
            $schema['maxLength'] = $constraint->max;
        }
    }

    /** @param array<string, mixed> $schema */
    private function applyRegex(array &$schema, Assert\Regex $constraint, string $type): void
    {
        if ($type !== 'string' || !is_string($constraint->pattern)) {
            throw new UnsupportedInputShapeException('Regex is portable only for strings.');
        }
        $schema['pattern'] = PortablePattern::fromSymfonyRegex($constraint->pattern);
    }

    /** @param array<string, mixed> $schema */
    private function applyUuid(array &$schema, string $type): void
    {
        if ($type !== 'string') {
            throw new UnsupportedInputShapeException('Uuid is portable only for strings.');
        }
        $schema['format'] = 'uuid';
    }

    /** @param array<string, mixed> $schema */
    private function applyChoice(array &$schema, Assert\Choice $constraint): void
    {
        if (!is_array($constraint->choices)) {
            throw new UnsupportedInputShapeException('Choice callback is not portable.');
        }
        foreach ($constraint->choices as $choice) {
            if ($choice !== null
                && !is_string($choice)
                && !is_int($choice)
                && !is_float($choice)
                && !is_bool($choice)) {
                throw new UnsupportedInputShapeException('Choice contains a non-JSON scalar.');
            }
        }
        $schema['enum'] = array_values($constraint->choices);
    }
}
