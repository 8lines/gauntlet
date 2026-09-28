<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Http;

use EightLines\Gauntlet\Core\DataSource\DataSourceQuery;
use EightLines\Gauntlet\Core\DataSource\DataSourceResolveRequest;
use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Json\JsonList;
use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Problem\ValidationError;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;
use EightLines\Gauntlet\Core\Run\CreateRunRequest;
use EightLines\Gauntlet\Core\Run\ConfirmationAcknowledgement;
use EightLines\Gauntlet\Core\Run\InvocationContext;

final class EnvelopeMapper
{
    /** @return array{request: CreateRunRequest, rawContext: ?JsonObject} */
    public function createRun(JsonObject $envelope): array
    {
        $values = $envelope->values();
        $this->assertKnownKeys($values, [
            'operationRevision',
            'input',
            'context',
            'dryRun',
            'idempotencyKey',
            'confirmation',
            'extensions',
        ]);
        $revision = $this->requiredString($values, 'operationRevision');
        if (preg_match('/^sha256:[0-9a-f]{64}$/D', $revision) !== 1) {
            $this->reject('/operationRevision', '#/properties/operationRevision/pattern', 'pattern');
        }
        $input = $values['input'] ?? null;
        if (!$input instanceof JsonObject) {
            $this->reject('/input', '#/properties/input/type', 'type');
        }
        $context = $this->optionalContext($values['context'] ?? null, '/context');
        $dryRun = $values['dryRun'] ?? false;
        if (!is_bool($dryRun)) {
            $this->reject('/dryRun', '#/properties/dryRun/type', 'type');
        }
        $idempotencyKey = $values['idempotencyKey'] ?? null;
        if ($idempotencyKey !== null && (!is_string($idempotencyKey) || $idempotencyKey === '')) {
            $this->reject('/idempotencyKey', '#/properties/idempotencyKey/type', 'type');
        }
        $confirmation = array_key_exists('confirmation', $values)
            ? $this->confirmation($values['confirmation'])
            : null;

        return [
            'request' => new CreateRunRequest(
                operationRevision: $revision,
                input: $input,
                context: $context['context'],
                dryRun: $dryRun,
                idempotencyKey: $idempotencyKey,
                extensions: $this->extensions($values['extensions'] ?? null),
                confirmation: $confirmation,
            ),
            'rawContext' => $context['raw'],
        ];
    }

    private function confirmation(mixed $value): ConfirmationAcknowledgement
    {
        if (!$value instanceof JsonObject) {
            $this->reject('/confirmation', '#/$defs/confirmationAcknowledgement/type', 'type');
        }
        $values = $value->values();
        $allowed = array_fill_keys(['operationId', 'operationRevision', 'impact', 'extensions'], true);
        foreach (array_keys($values) as $key) {
            if (!isset($allowed[$key])) {
                $this->reject(
                    '/confirmation/' . self::pointerToken($key),
                    '#/$defs/confirmationAcknowledgement/additionalProperties',
                    'additionalProperties',
                );
            }
        }

        $operationId = $this->confirmationString($values, 'operationId');
        try {
            ProtocolId::assert($operationId);
        } catch (\InvalidArgumentException) {
            $this->reject(
                '/confirmation/operationId',
                '#/$defs/confirmationAcknowledgement/properties/operationId',
                'pattern',
            );
        }

        $operationRevision = $this->confirmationString($values, 'operationRevision');
        if (preg_match('/^sha256:[0-9a-f]{64}$/D', $operationRevision) !== 1) {
            $this->reject(
                '/confirmation/operationRevision',
                '#/$defs/confirmationAcknowledgement/properties/operationRevision',
                'pattern',
            );
        }

        $impactValue = $this->confirmationString($values, 'impact');
        $impact = OperationImpact::tryFrom($impactValue);
        if ($impact === null) {
            $this->reject(
                '/confirmation/impact',
                '#/$defs/confirmationAcknowledgement/properties/impact',
                'enum',
            );
        }

        $extensions = null;
        if (array_key_exists('extensions', $values)) {
            if (!$values['extensions'] instanceof JsonObject) {
                $this->reject('/confirmation/extensions', '#/$defs/extensions/type', 'type');
            }
            $extensions = $this->extensions($values['extensions'], '/confirmation/extensions');
        }

        return new ConfirmationAcknowledgement(
            operationId: $operationId,
            operationRevision: $operationRevision,
            impact: $impact,
            extensions: $extensions,
        );
    }

    /** @param array<string, mixed> $values */
    private function confirmationString(array $values, string $name): string
    {
        if (!array_key_exists($name, $values)) {
            $this->reject(
                '/confirmation/' . $name,
                '#/$defs/confirmationAcknowledgement/required',
                'required',
            );
        }
        if (!is_string($values[$name])) {
            $this->reject(
                '/confirmation/' . $name,
                '#/$defs/confirmationAcknowledgement/properties/' . $name . '/type',
                'type',
            );
        }

        return $values[$name];
    }

    public function dataSourceQuery(JsonObject $envelope): DataSourceQuery
    {
        $values = $envelope->values();
        $this->assertKnownKeys($values, ['search', 'cursor', 'limit', 'dependencies', 'context', 'extensions']);
        $search = $this->optionalString($values, 'search');
        $cursor = $this->optionalString($values, 'cursor');
        $limit = $values['limit'] ?? null;
        if ($limit !== null && (!is_int($limit) || $limit < 1)) {
            $this->reject('/limit', '#/properties/limit', 'minimum');
        }
        $dependencies = $this->dependencies($values['dependencies'] ?? null);
        $context = $this->optionalContext($values['context'] ?? null, '/context');

        return new DataSourceQuery(
            $search,
            $cursor,
            $limit,
            $dependencies,
            $context['context'],
            $this->extensions($values['extensions'] ?? null),
        );
    }

    public function dataSourceResolve(JsonObject $envelope): DataSourceResolveRequest
    {
        $values = $envelope->values();
        $this->assertKnownKeys($values, ['values', 'dependencies', 'context', 'extensions']);
        $list = $values['values'] ?? null;
        if (!$list instanceof JsonList) {
            $this->reject('/values', '#/properties/values/type', 'type');
        }
        $resolvedValues = $list->values();
        foreach ($resolvedValues as $index => $value) {
            if (!is_string($value)) {
                $this->reject('/values/' . $index, '#/properties/values/items/type', 'type');
            }
        }
        $dependencies = $this->dependencies($values['dependencies'] ?? null);
        $context = $this->optionalContext($values['context'] ?? null, '/context');

        return new DataSourceResolveRequest(
            $resolvedValues,
            $dependencies,
            $context['context'],
            $this->extensions($values['extensions'] ?? null),
        );
    }

    /** @param array<string, mixed> $values @param list<string> $allowed */
    private function assertKnownKeys(array $values, array $allowed): void
    {
        $known = array_fill_keys($allowed, true);
        foreach (array_keys($values) as $key) {
            if (!isset($known[$key])) {
                $this->reject('/' . self::pointerToken($key), '#/additionalProperties', 'additionalProperties');
            }
        }
    }

    /** @param array<string, mixed> $values */
    private function requiredString(array $values, string $name): string
    {
        $value = $values[$name] ?? null;
        if (!is_string($value)) {
            $this->reject('/' . $name, '#/required', 'required');
        }

        return $value;
    }

    /** @param array<string, mixed> $values */
    private function optionalString(array $values, string $name): ?string
    {
        $value = $values[$name] ?? null;
        if ($value !== null && !is_string($value)) {
            $this->reject('/' . $name, '#/properties/' . $name . '/type', 'type');
        }

        return $value;
    }

    private function dependencies(mixed $value): JsonObject
    {
        if ($value === null) {
            return JsonOwnership::object([]);
        }
        if (!$value instanceof JsonObject) {
            $this->reject('/dependencies', '#/properties/dependencies/type', 'type');
        }
        foreach (array_keys($value->values()) as $pointer) {
            if (preg_match('/^(?:\/(?:[^~\/]|~[01])*)*$/D', $pointer) !== 1) {
                $this->reject(
                    '/dependencies/' . self::pointerToken($pointer),
                    '#/properties/dependencies/propertyNames',
                    'pattern',
                );
            }
        }

        return $value;
    }

    private function extensions(mixed $value, string $instancePath = '/extensions'): ?ProtocolExtensions
    {
        if ($value === null) {
            return null;
        }
        if (!$value instanceof JsonObject) {
            $this->reject($instancePath, '#/$defs/extensions/type', 'type');
        }

        try {
            return new ProtocolExtensions($value);
        } catch (\InvalidArgumentException) {
            $path = $instancePath;
            foreach (array_keys($value->values()) as $key) {
                if (preg_match('/^urn:[A-Za-z0-9][A-Za-z0-9:._\/-]*$/D', $key) !== 1) {
                    $path .= '/' . self::pointerToken($key);
                    break;
                }
            }
            $this->reject($path, '#/$defs/extensions/propertyNames', 'pattern');
        }
    }

    /** @return array{context: ?InvocationContext, raw: ?JsonObject} */
    private function optionalContext(mixed $value, string $instancePath): array
    {
        if ($value === null) {
            return ['context' => null, 'raw' => null];
        }
        if (!$value instanceof JsonObject) {
            $this->reject($instancePath, '#/$defs/invocationContext/type', 'type');
        }
        $values = $value->values();
        $this->assertContextKeys($values, $instancePath);
        $requestId = $values['requestId'] ?? null;
        if (!is_string($requestId)) {
            $this->reject($instancePath . '/requestId', '#/$defs/invocationContext/required', 'required');
        }
        try {
            ProtocolId::assert($requestId);
        } catch (\InvalidArgumentException) {
            $this->reject($instancePath . '/requestId', '#/$defs/invocationContext/properties/requestId', 'pattern');
        }

        $target = $this->contextObject($values['target'] ?? null, $instancePath . '/target', ['id', 'environment']);
        $actor = $this->contextObject($values['actor'] ?? null, $instancePath . '/actor', ['id', 'displayName']);
        $extensions = $values['extensions'] ?? null;
        if ($extensions !== null && !$extensions instanceof JsonObject) {
            $this->reject($instancePath . '/extensions', '#/$defs/extensions/type', 'type');
        }
        if ($extensions instanceof JsonObject) {
            foreach (array_keys($extensions->values()) as $key) {
                if (preg_match('/^urn:[A-Za-z0-9][A-Za-z0-9:._\/-]*$/D', $key) !== 1) {
                    $this->reject(
                        $instancePath . '/extensions/' . self::pointerToken($key),
                        '#/$defs/extensions/propertyNames',
                        'pattern',
                    );
                }
            }
        }
        foreach (['locale', 'timeZone'] as $name) {
            if (isset($values[$name]) && !is_string($values[$name])) {
                $this->reject(
                    $instancePath . '/' . $name,
                    '#/$defs/invocationContext/properties/' . $name . '/type',
                    'type',
                );
            }
        }

        return [
            'context' => new InvocationContext(
                requestId: $requestId,
                target: $target,
                actor: $actor,
                locale: $values['locale'] ?? null,
                timeZone: $values['timeZone'] ?? null,
                extensions: $extensions,
            ),
            'raw' => $value,
        ];
    }

    /** @param array<string, mixed> $values */
    private function assertContextKeys(array $values, string $instancePath): void
    {
        $allowed = array_fill_keys(['requestId', 'target', 'actor', 'locale', 'timeZone', 'extensions'], true);
        foreach (array_keys($values) as $key) {
            if (!isset($allowed[$key])) {
                $this->reject(
                    $instancePath . '/' . self::pointerToken($key),
                    '#/$defs/invocationContext/additionalProperties',
                    'additionalProperties',
                );
            }
        }
    }

    /** @param list<string> $allowed */
    private function contextObject(mixed $value, string $instancePath, array $allowed): ?JsonObject
    {
        if ($value === null) {
            return null;
        }
        if (!$value instanceof JsonObject) {
            $this->reject($instancePath, '#/type', 'type');
        }
        $values = $value->values();
        $known = array_fill_keys($allowed, true);
        foreach (array_keys($values) as $key) {
            if (!isset($known[$key])) {
                $this->reject(
                    $instancePath . '/' . self::pointerToken($key),
                    '#/additionalProperties',
                    'additionalProperties',
                );
            }
        }
        $id = $values['id'] ?? null;
        if (!is_string($id)) {
            $this->reject($instancePath . '/id', '#/required', 'required');
        }
        try {
            ProtocolId::assert($id);
        } catch (\InvalidArgumentException) {
            $this->reject($instancePath . '/id', '#/properties/id/pattern', 'pattern');
        }
        foreach ($values as $key => $item) {
            if ($key !== 'id' && !is_string($item)) {
                $this->reject($instancePath . '/' . $key, '#/type', 'type');
            }
        }

        return $value;
    }

    private function reject(string $instancePath, string $schemaPath, string $keyword): never
    {
        throw new RequestProblemException(Problem::validation([
            new ValidationError(
                instancePath: $instancePath,
                schemaPath: $schemaPath,
                keyword: $keyword,
                message: 'Invalid value.',
                params: JsonOwnership::object([]),
            ),
        ]));
    }

    private static function pointerToken(string $value): string
    {
        return str_replace(['~', '/'], ['~0', '~1'], $value);
    }
}
