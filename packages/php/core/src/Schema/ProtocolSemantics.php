<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Schema;

use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Json\Rfc8785CanonicalJson;
use EightLines\Gauntlet\Core\Manifest\AdapterManifest;
use EightLines\Gauntlet\Core\Protocol\EnvironmentDescriptor;

/** Framework-neutral port of the accepted Gauntlet v1 semantic predicates. */
final class ProtocolSemantics
{
    public static function manifestSemanticsAreValid(object $manifest): bool
    {
        try {
            $wire = self::wireObject($manifest);
            $application = $wire->application ?? null;
            if (!($application instanceof \stdClass)) {
                return false;
            }
            $environment = $application->environment ?? null;
            if (!($environment instanceof \stdClass)) {
                return false;
            }
            EnvironmentDescriptor::fromProtocolValue(get_object_vars($environment));
            if (
                !property_exists($wire, 'manifestRevision')
                || !is_string($wire->manifestRevision)
                || self::revision($wire, 'manifestRevision') !== $wire->manifestRevision
            ) {
                return false;
            }
            if (!is_array($wire->features ?? null) || !self::featureTreeIsValid($wire->features)) {
                return false;
            }
            if (!is_array($wire->operations ?? null) || !is_array($wire->dataSources ?? null)) {
                return false;
            }

            $featureIds = self::stringFieldSet($wire->features, 'id');
            $operationIds = self::stringFields($wire->operations, 'id');
            $dataSourceIds = self::stringFields($wire->dataSources, 'id');
            if (
                $featureIds === null
                || $operationIds === null
                || $dataSourceIds === null
                || !self::allUnique($operationIds)
                || !self::allUnique($dataSourceIds)
            ) {
                return false;
            }

            $profiles = self::stringSet($wire->profiles ?? null);
            $capabilities = self::stringSet($wire->capabilities ?? null);
            if ($profiles === null || $capabilities === null) {
                return false;
            }
            foreach ($wire->operations as $operation) {
                if (
                    !$operation instanceof \stdClass
                    || !is_string($operation->featureId ?? null)
                    || !isset($featureIds[$operation->featureId])
                ) {
                    return false;
                }
                if (property_exists($operation, 'placements') && !isset($profiles[PlacementRules::PROFILE])) {
                    return false;
                }
                $availability = $operation->availability ?? null;
                if (
                    $availability instanceof \stdClass
                    && ($availability->state ?? null) === 'available'
                    && !self::requirementsAreDeclared(
                        $operation->requirements ?? null,
                        $profiles,
                        $capabilities,
                    )
                ) {
                    return false;
                }
            }

            foreach ($wire->dataSources as $dataSource) {
                if (
                    !$dataSource instanceof \stdClass
                    || !($dataSource->capabilities ?? null) instanceof \stdClass
                ) {
                    return false;
                }
                $defaultLimit = $dataSource->capabilities->defaultLimit ?? null;
                $maxLimit = $dataSource->capabilities->maxLimit ?? null;
                if (!is_int($defaultLimit) || !is_int($maxLimit) || $defaultLimit > $maxLimit) {
                    return false;
                }
                if (property_exists($dataSource, 'dependencySchema')) {
                    self::assertSchemaProfile($dataSource->dependencySchema, true);
                }
                if (property_exists($dataSource, 'contextSchema')) {
                    self::assertSchemaProfile($dataSource->contextSchema, true);
                }
            }

            return true;
        } catch (\Throwable) {
            return false;
        }
    }

    public static function operationSemanticsAreValid(object $operation): bool
    {
        try {
            $wire = self::wireObject($operation);
            $execution = $wire->execution ?? null;
            if (!($execution instanceof \stdClass)) {
                return false;
            }
            if (($execution->impact ?? null) === 'destructive'
                && (($execution->confirmationRequired ?? null) !== true
                    || ($execution->idempotency ?? null) !== 'required')) {
                return false;
            }
            if (
                !property_exists($wire, 'revision')
                || !is_string($wire->revision)
                || self::revision($wire) !== $wire->revision
            ) {
                return false;
            }

            self::assertSchemaProfile($wire->inputSchema ?? null, true);
            if (property_exists($wire, 'contextSchema')) {
                self::assertSchemaProfile($wire->contextSchema, true);
            }
            $output = $wire->output ?? null;
            if (!$output instanceof \stdClass || !property_exists($output, 'schema')) {
                return false;
            }
            self::assertSchemaProfile($output->schema, false);

            if (!is_array($wire->dataSources ?? null) || !is_array($wire->presets ?? null)) {
                return false;
            }
            $dataSourceIds = self::stringFields($wire->dataSources, 'id');
            $presetIds = self::stringFields($wire->presets, 'id');
            if (
                $dataSourceIds === null
                || $presetIds === null
                || !self::allUnique($dataSourceIds)
                || !self::allUnique($presetIds)
            ) {
                return false;
            }

            $secretPointers = [];
            $handling = $wire->inputHandling ?? null;
            if ($handling !== null) {
                if (!$handling instanceof \stdClass || !is_array($handling->rules ?? null)) {
                    return false;
                }
                foreach ($handling->rules as $rule) {
                    if (
                        $rule instanceof \stdClass
                        && ($rule->kind ?? null) === 'secret'
                        && is_string($rule->schemaPointer ?? null)
                    ) {
                        $secretPointers[] = $rule->schemaPointer;
                    }
                }
            }
            if (
                !$wire->inputSchema instanceof \stdClass
                || !PresetSecretAnalyzer::presetsOmitSecrets(
                    $wire->inputSchema,
                    $secretPointers,
                    $wire->presets,
                )
            ) {
                return false;
            }

            if (property_exists($wire, 'placements')) {
                $guarded = [];
                foreach (($handling->rules ?? []) as $rule) {
                    if ($rule instanceof \stdClass && is_string($rule->schemaPointer ?? null)) {
                        $guarded[] = $rule->schemaPointer;
                    }
                }
                if (!is_array($wire->placements) || !PlacementRules::areValid($wire->inputSchema, $guarded, $wire->placements)) {
                    return false;
                }
            }

            $declaredDataSources = array_fill_keys($dataSourceIds, true);
            foreach (self::uiDataSourceIds($wire->uiSchema->root ?? null) as $referencedId) {
                if (!isset($declaredDataSources[$referencedId])) {
                    return false;
                }
            }

            return true;
        } catch (\Throwable) {
            return false;
        }
    }

    /**
     * Accepts raw request/response objects or the legacy request-values and
     * response-results arrays used by the HTTP adapter.
     */
    public static function resolveSemanticsAreValid(object|array $request, object|array $response): bool
    {
        $values = is_array($request) ? $request : ($request->values ?? null);
        $results = is_array($response) ? $response : ($response->results ?? null);
        if (!is_array($values) || !is_array($results) || count($values) !== count($results)) {
            return false;
        }

        foreach ($results as $index => $result) {
            $resultValue = self::member($result, 'value');
            if (!is_string($resultValue) || !array_key_exists($index, $values) || $resultValue !== $values[$index]) {
                return false;
            }
            $item = self::member($result, 'item');
            if ($item !== null && self::member($item, 'value') !== $resultValue) {
                return false;
            }
        }

        return true;
    }

    /** Backward-compatible typed alias. */
    public static function operationIsValid(OperationDefinition $operation): bool
    {
        return self::operationSemanticsAreValid($operation);
    }

    /** Backward-compatible typed alias. */
    public static function manifestIsValid(AdapterManifest $manifest): bool
    {
        return self::manifestSemanticsAreValid($manifest);
    }

    private static function wireObject(object $document): \stdClass
    {
        if ($document instanceof \stdClass) {
            return $document;
        }
        if (!method_exists($document, 'toProtocolArray')) {
            throw new \InvalidArgumentException('Unsupported protocol document.');
        }
        $wire = JsonOwnership::transport(JsonOwnership::object($document->toProtocolArray()));
        if (!$wire instanceof \stdClass) {
            throw new \LogicException('Protocol document must serialize as an object.');
        }

        return $wire;
    }

    private static function revision(\stdClass $document, string $field = 'revision'): string
    {
        return Rfc8785CanonicalJson::revision(JsonOwnership::object(get_object_vars($document)), $field);
    }

    private static function assertSchemaProfile(mixed $schema, bool $requireObjectRoot): void
    {
        if (!$schema instanceof \stdClass) {
            throw new \InvalidArgumentException('Schema root must be an object.');
        }
        TcSchemaCore::assert(JsonOwnership::object(get_object_vars($schema)), $requireObjectRoot);
    }

    /** @param list<mixed> $features */
    private static function featureTreeIsValid(array $features): bool
    {
        $parents = [];
        foreach ($features as $feature) {
            if (!$feature instanceof \stdClass || !is_string($feature->id ?? null)) {
                return false;
            }
            if (array_key_exists($feature->id, $parents)) {
                return false;
            }
            $parentId = $feature->parentId ?? null;
            if ($parentId !== null && !is_string($parentId)) {
                return false;
            }
            $parents[$feature->id] = $parentId;
        }

        foreach ($parents as $featureId => $parentId) {
            $visited = [$featureId => true];
            while ($parentId !== null) {
                if (!array_key_exists($parentId, $parents) || isset($visited[$parentId])) {
                    return false;
                }
                $visited[$parentId] = true;
                $parentId = $parents[$parentId];
            }
        }

        return true;
    }

    /**
     * @param array<string,true> $profiles
     * @param array<string,true> $capabilities
     */
    private static function requirementsAreDeclared(
        mixed $requirements,
        array $profiles,
        array $capabilities,
    ): bool {
        if ($requirements === null) {
            return true;
        }
        if (!$requirements instanceof \stdClass) {
            return false;
        }
        foreach ([['profiles', $profiles], ['capabilities', $capabilities]] as [$field, $declared]) {
            if (!property_exists($requirements, $field)) {
                continue;
            }
            if (!is_array($requirements->{$field})) {
                return false;
            }
            foreach ($requirements->{$field} as $required) {
                if (!is_string($required) || !isset($declared[$required])) {
                    return false;
                }
            }
        }

        return true;
    }

    /** @return list<string> */
    private static function uiDataSourceIds(mixed $root): array
    {
        $ids = [];
        $pending = [$root];
        while ($pending !== []) {
            $node = array_pop($pending);
            if (!$node instanceof \stdClass) {
                continue;
            }
            if (($node->type ?? null) === 'field' && is_string($node->dataSourceId ?? null)) {
                $ids[] = $node->dataSourceId;
            }
            foreach (['children', 'tabs'] as $field) {
                if (is_array($node->{$field} ?? null)) {
                    foreach ($node->{$field} as $child) {
                        $pending[] = $child;
                    }
                }
            }
        }

        return $ids;
    }

    /** @param list<mixed> $records @return list<string>|null */
    private static function stringFields(array $records, string $field): ?array
    {
        $values = [];
        foreach ($records as $record) {
            if (!$record instanceof \stdClass || !is_string($record->{$field} ?? null)) {
                return null;
            }
            $values[] = $record->{$field};
        }

        return $values;
    }

    /** @param list<mixed> $records @return array<string,true>|null */
    private static function stringFieldSet(array $records, string $field): ?array
    {
        $values = self::stringFields($records, $field);
        if ($values === null || !self::allUnique($values)) {
            return null;
        }

        return array_fill_keys($values, true);
    }

    /** @return array<string,true>|null */
    private static function stringSet(mixed $values): ?array
    {
        if (!is_array($values)) {
            return null;
        }
        foreach ($values as $value) {
            if (!is_string($value)) {
                return null;
            }
        }

        return array_fill_keys($values, true);
    }

    /** @param list<string> $values */
    private static function allUnique(array $values): bool
    {
        return count(array_unique($values)) === count($values);
    }

    private static function member(mixed $record, string $field): mixed
    {
        if ($record instanceof \stdClass) {
            return $record->{$field} ?? null;
        }
        if (is_array($record)) {
            return $record[$field] ?? null;
        }

        return null;
    }
}
