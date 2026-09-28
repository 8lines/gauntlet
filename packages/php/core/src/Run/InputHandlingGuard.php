<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

use EightLines\Gauntlet\Core\Contract\FileReferenceValidator;
use EightLines\Gauntlet\Core\Definition\InputHandling;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Json\JsonValue;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Result\FileReference;
use EightLines\Gauntlet\Core\Schema\PresetSecretAnalyzer;

final class InputHandlingGuard
{
    public static function validate(
        OperationDefinition $definition,
        JsonObject $input,
        ?FileReferenceValidator $fileValidator,
        ?string $correlationId = null,
    ): ?Problem {
        $handling = $definition->inputHandling;
        if ($handling === null || !$handling->hasFiles()) {
            return null;
        }
        if ($fileValidator === null) {
            return new Problem(
                'urn:gauntlet:problem:unsupported-capability',
                'Capability is not supported',
                501,
                correlationId: $correlationId,
                capability: 'tc-uploads@1',
            );
        }

        foreach ($handling->rules as $rule) {
            if ($rule['kind'] !== 'file') {
                continue;
            }
            $resolved = PresetSecretAnalyzer::valuesAtSchemaPointers(
                $definition->inputSchema->jsonSerialize(),
                [$rule['schemaPointer']],
                $input->jsonSerialize(),
            );
            if ($resolved === null) {
                return self::invalid($correlationId);
            }

            foreach ($resolved as $value) {
                $values = $rule['multiple'] ? $value : [$value];
                if (!is_array($values) || !array_is_list($values)) {
                    return self::invalid($correlationId);
                }
                foreach ($values as $candidate) {
                    try {
                        $reference = self::fileReference($candidate);
                        if (
                            isset($rule['mediaTypes'])
                            && !in_array($reference->mediaType, $rule['mediaTypes'], true)
                        ) {
                            return self::invalid($correlationId);
                        }
                        if (isset($rule['maxBytes']) && $reference->sizeBytes > $rule['maxBytes']) {
                            return self::invalid($correlationId);
                        }
                        if (!$fileValidator->validate($reference, $definition->id, $definition->revision())) {
                            return self::invalid($correlationId);
                        }
                    } catch (\Throwable) {
                        return self::invalid($correlationId);
                    }
                }
            }
        }

        return null;
    }

    public static function containsSecret(InputHandling $handling, JsonObject $input, JsonObject $schema): bool
    {
        $values = PresetSecretAnalyzer::valuesAtSchemaPointers(
            $schema->jsonSerialize(),
            $handling->secretSchemaPointers(),
            $input->jsonSerialize(),
        );

        return $values === null || $values !== [];
    }

    /** @return array<string,true>|null */
    public static function secretValues(OperationDefinition $definition, JsonObject $input): ?array
    {
        if ($definition->inputHandling === null || !$definition->inputHandling->hasSecrets()) {
            return [];
        }
        $values = PresetSecretAnalyzer::valuesAtSchemaPointers(
            $definition->inputSchema->jsonSerialize(),
            $definition->inputHandling->secretSchemaPointers(),
            $input->jsonSerialize(),
        );
        if ($values === null) {
            return null;
        }

        $scalars = [];
        $pending = $values;
        while ($pending !== []) {
            $value = array_pop($pending);
            if ($value === null || is_bool($value) || is_string($value) || is_int($value) || is_float($value)) {
                $scalars[self::scalarFingerprint($value)] = true;
            } elseif (is_array($value)) {
                foreach ($value as $child) {
                    $pending[] = $child;
                }
            } elseif ($value instanceof \stdClass) {
                foreach (get_object_vars($value) as $child) {
                    $pending[] = $child;
                }
            }
        }

        return $scalars;
    }

    /** @param array<string,true> $needles */
    public static function containsAny(mixed $value, array $needles): bool
    {
        if ($needles === []) {
            return false;
        }
        $pending = [$value];
        while ($pending !== []) {
            $current = array_pop($pending);
            if (self::scalarMatches($current, $needles)) {
                return true;
            }
            if ($current instanceof JsonValue) {
                $pending[] = $current->jsonSerialize();
            } elseif (is_array($current)) {
                foreach ($current as $key => $child) {
                    if (is_string($key) && self::stringMatches($key, $needles)) {
                        return true;
                    }
                    $pending[] = $child;
                }
            } elseif ($current instanceof \stdClass) {
                foreach (get_object_vars($current) as $key => $child) {
                    if (self::stringMatches($key, $needles)) {
                        return true;
                    }
                    $pending[] = $child;
                }
            }
        }

        return false;
    }

    /** @param array<string,true> $needles */
    private static function scalarMatches(mixed $value, array $needles): bool
    {
        if (is_string($value)) {
            return self::stringMatches($value, $needles);
        }
        if ($value === null || is_bool($value) || is_int($value) || is_float($value)) {
            return isset($needles[self::scalarFingerprint($value)]);
        }

        return false;
    }

    /** @param array<string,true> $needles */
    private static function stringMatches(string $value, array $needles): bool
    {
        foreach ($needles as $fingerprint => $_) {
            if (str_starts_with($fingerprint, 'string:') && str_contains($value, substr($fingerprint, 7))) {
                return true;
            }
        }

        return false;
    }

    private static function scalarFingerprint(null|bool|string|int|float $value): string
    {
        if (is_string($value)) {
            return 'string:' . $value;
        }
        if ($value === null) {
            return 'null:';
        }
        if (is_bool($value)) {
            return 'bool:' . ($value ? 'true' : 'false');
        }

        return 'number:' . json_encode($value, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION);
    }

    private static function fileReference(mixed $value): FileReference
    {
        if (!$value instanceof \stdClass) {
            throw new \InvalidArgumentException('File reference must be an object.');
        }
        $members = get_object_vars($value);
        $allowed = ['kind', 'uploadId', 'name', 'mediaType', 'sizeBytes', 'sha256', 'expiresAt', 'extensions'];
        if (array_diff(array_keys($members), $allowed) !== [] || ($members['kind'] ?? null) !== 'file') {
            throw new \InvalidArgumentException('Invalid file reference.');
        }
        $extensions = null;
        if (array_key_exists('extensions', $members)) {
            if (!$members['extensions'] instanceof \stdClass) {
                throw new \InvalidArgumentException('Invalid file reference extensions.');
            }
            $extensions = new ProtocolExtensions(JsonOwnership::object(get_object_vars($members['extensions'])));
        }

        $sha256 = null;
        if (array_key_exists('sha256', $members)) {
            if (!is_string($members['sha256'])) {
                throw new \InvalidArgumentException('Invalid file digest.');
            }
            $sha256 = $members['sha256'];
        }

        return new FileReference(
            uploadId: self::stringMember($members, 'uploadId'),
            name: self::stringMember($members, 'name'),
            mediaType: self::stringMember($members, 'mediaType'),
            sizeBytes: is_int($members['sizeBytes'] ?? null)
                ? $members['sizeBytes']
                : throw new \InvalidArgumentException('Invalid file size.'),
            expiresAt: self::stringMember($members, 'expiresAt'),
            sha256: $sha256,
            extensions: $extensions,
        );
    }

    /** @param array<string,mixed> $members */
    private static function stringMember(array $members, string $name): string
    {
        if (!isset($members[$name]) || !is_string($members[$name])) {
            throw new \InvalidArgumentException('Invalid file reference member.');
        }

        return $members[$name];
    }

    private static function invalid(?string $correlationId): Problem
    {
        return new Problem(
            'urn:gauntlet:problem:validation-failed',
            'Validation failed',
            422,
            correlationId: $correlationId,
        );
    }
}
