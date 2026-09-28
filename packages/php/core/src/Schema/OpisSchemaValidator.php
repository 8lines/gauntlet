<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Schema;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Json\JsonValue;
use EightLines\Gauntlet\Core\Problem\ValidationError;
use Opis\JsonSchema\CompliantValidator;
use Opis\JsonSchema\Errors\ErrorFormatter;
use Opis\JsonSchema\Errors\ValidationError as OpisValidationError;
use Opis\JsonSchema\JsonPointer;

final class OpisSchemaValidator implements SchemaValidator
{
    private readonly CompliantValidator $validator;

    public function __construct()
    {
        $this->validator = new CompliantValidator(max_errors: 100, stop_at_first_error: false);
    }

    /** @return list<ValidationError> */
    public function validate(JsonObject $schema, JsonValue $instance): array
    {
        TcSchemaCore::assert($schema);
        $schemaValue = JsonOwnership::transport(JsonOwnership::own($schema));
        $instanceValue = JsonOwnership::transport(JsonOwnership::own($instance));

        try {
            $result = $this->validator->validate($instanceValue, $schemaValue);
        } catch (\Throwable) {
            throw new \InvalidArgumentException('Schema could not be evaluated safely.');
        }
        if ($result->isValid()) {
            return [];
        }

        $rootError = $result->error();
        if ($rootError === null) {
            return [];
        }

        $formatter = new ErrorFormatter();
        $errors = $formatter->formatFlat(
            $rootError,
            static function (OpisValidationError $error): ValidationError {
                $instancePath = JsonPointer::pathToString($error->data()->fullPath());
                if ($instancePath === '/') {
                    $instancePath = '';
                }
                if ($error->keyword() === 'required') {
                    $missing = $error->args()['missing'][0] ?? null;
                    if (is_string($missing)) {
                        $instancePath .= '/' . str_replace(['~', '/'], ['~0', '~1'], $missing);
                    }
                }
                if ($error->keyword() === 'additionalProperties') {
                    $properties = $error->args()['properties'] ?? [];
                    $schemaData = $error->schema()->info()->data();
                    $declared = $schemaData instanceof \stdClass && property_exists($schemaData, 'properties')
                        ? array_keys(get_object_vars($schemaData->properties))
                        : [];
                    $unexpected = is_array($properties) ? array_values(array_diff($properties, $declared)) : [];
                    $property = $unexpected[0] ?? null;
                    if (is_string($property)) {
                        $instancePath .= '/' . str_replace(['~', '/'], ['~0', '~1'], $property);
                    }
                }

                $schemaPath = '#';
                foreach ([...$error->schema()->info()->path(), $error->keyword()] as $segment) {
                    $schemaPath .= '/' . str_replace(['~', '/'], ['~0', '~1'], (string) $segment);
                }

                return new ValidationError(
                    $instancePath,
                    $schemaPath,
                    $error->keyword(),
                    self::safeMessage($error->keyword()),
                    JsonOwnership::object([]),
                );
            },
        );

        $aggregateKeywords = array_fill_keys([
            'properties',
            'patternProperties',
            'dependentSchemas',
            'items',
            'prefixItems',
            'allOf',
            'anyOf',
            'oneOf',
            'if',
            'then',
            'else',
            'contains',
            '$ref',
            '',
            'additionalProperties',
        ], true);
        $errors = array_values(array_filter(
            $errors,
            static function (ValidationError $candidate) use ($errors, $aggregateKeywords): bool {
                if ($candidate->keyword === 'additionalProperties') {
                    foreach ($errors as $other) {
                        if ($other !== $candidate
                            && $other->instancePath === $candidate->instancePath
                            && $other->keyword !== 'additionalProperties') {
                            return false;
                        }
                    }
                }
                if (!isset($aggregateKeywords[$candidate->keyword])) {
                    return true;
                }
                foreach ($errors as $other) {
                    if ($other === $candidate) {
                        continue;
                    }
                    if ($candidate->keyword === '' && $other->keyword !== '') {
                        return false;
                    }
                    if ($other->instancePath === $candidate->instancePath) {
                        continue;
                    }
                    $prefix = $candidate->instancePath === '' ? '/' : $candidate->instancePath . '/';
                    if (str_starts_with($other->instancePath, $prefix)) {
                        return false;
                    }
                }

                return true;
            },
        ));

        $unique = [];
        foreach ($errors as $error) {
            $key = $error->instancePath . "\0" . $error->schemaPath . "\0" . $error->keyword;
            $unique[$key] = $error;
        }
        $errors = array_values($unique);

        usort($errors, static fn (ValidationError $left, ValidationError $right): int =>
            [$left->instancePath, $left->schemaPath, $left->keyword]
            <=> [$right->instancePath, $right->schemaPath, $right->keyword]);

        return $errors;
    }

    private static function safeMessage(string $keyword): string
    {
        return match ($keyword) {
            'required' => 'required property is missing',
            'additionalProperties' => 'additional properties are not allowed',
            'type' => 'value has an invalid type',
            'format' => 'string has an invalid format',
            'pattern' => 'string does not match the required pattern',
            default => 'value does not satisfy the schema',
        };
    }
}
