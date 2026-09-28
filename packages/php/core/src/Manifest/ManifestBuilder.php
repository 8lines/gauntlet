<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Manifest;

use EightLines\Gauntlet\Core\Definition\DataSourceDefinition;
use EightLines\Gauntlet\Core\Definition\FeatureDefinition;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Protocol\EnvironmentDescriptor;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;
use EightLines\Gauntlet\Core\Protocol\ProtocolValue;
use EightLines\Gauntlet\Core\Registry\RegistryDiagnostic;
use EightLines\Gauntlet\Core\Schema\PlacementRules;

final readonly class ManifestBuilder
{
    /**
     * @param list<string> $profiles
     * @param list<string> $capabilities
     */
    public function __construct(
        private string $applicationId,
        private string $applicationLabel,
        private array $profiles,
        private EnvironmentDescriptor $environment,
        private array $capabilities = [],
        private ?ProtocolExtensions $extensions = null,
    ) {
        ProtocolId::assert($applicationId);
        ProtocolValue::assertNonBlank($applicationLabel, 'Application label');
        ProtocolValue::assertUniqueStrings($profiles, 'manifest profiles', true);
        ProtocolValue::assertUniqueStrings($capabilities, 'manifest capabilities', true);
    }

    /**
     * @param list<FeatureDefinition> $features
     * @param list<OperationDefinition> $operations
     * @param list<DataSourceDefinition> $dataSources
     */
    public function build(array $features, array $operations, array $dataSources): AdapterManifest
    {
        self::assertTypedList($features, FeatureDefinition::class);
        self::assertTypedList($operations, OperationDefinition::class);
        self::assertTypedList($dataSources, DataSourceDefinition::class);
        usort($features, static fn (FeatureDefinition $left, FeatureDefinition $right): int => $left->id <=> $right->id);
        usort($operations, static fn (OperationDefinition $left, OperationDefinition $right): int => $left->id <=> $right->id);
        usort(
            $dataSources,
            static fn (DataSourceDefinition $left, DataSourceDefinition $right): int => $left->id <=> $right->id,
        );

        $featureIds = array_fill_keys(array_map(static fn (FeatureDefinition $feature): string => $feature->id, $features), true);
        $dataSourceIds = array_fill_keys(
            array_map(static fn (DataSourceDefinition $source): string => $source->id, $dataSources),
            true,
        );
        $summaries = [];
        $diagnostics = [];
        foreach ($operations as $operation) {
            if (!isset($featureIds[$operation->featureId])) {
                $diagnostics[] = new RegistryDiagnostic(
                    'unknown_feature',
                    'Operation references an unknown feature.',
                    operationId: $operation->id,
                );
                continue;
            }
            $unknownSource = false;
            foreach ($operation->dataSources as $reference) {
                if (!isset($dataSourceIds[$reference->id])) {
                    $unknownSource = true;
                    break;
                }
            }
            if ($unknownSource) {
                $diagnostics[] = new RegistryDiagnostic(
                    'unknown_data_source',
                    'Operation references an unknown data source.',
                    operationId: $operation->id,
                );
                continue;
            }

            $summaries[] = $this->requirementsAreAvailable($operation)
                ? OperationSummary::available($operation)
                : OperationSummary::unavailable($operation, new Problem(
                    'urn:gauntlet:problem:requirements-unavailable',
                    'Operation requirements are unavailable',
                    501,
                ));
        }

        /** @var array{id: string, label: string, environment: array{name: string, kind: string}} $application */
        $application = [
            'id' => $this->applicationId,
            'label' => $this->applicationLabel,
            'environment' => $this->environment->toProtocolArray(),
        ];

        // Configured profiles pass through unchanged; the placements profile is appended only when needed.
        $profiles = $this->profiles;
        foreach ($operations as $operation) {
            if ($operation->placements !== [] && !in_array(PlacementRules::PROFILE, $profiles, true)) {
                $profiles[] = PlacementRules::PROFILE;
            }
        }

        return new AdapterManifest(
            $application,
            $profiles,
            $this->capabilities,
            $features,
            $summaries,
            $dataSources,
            $diagnostics,
            $this->extensions,
        );
    }

    private function requirementsAreAvailable(OperationDefinition $operation): bool
    {
        if ($operation->requirements === null) {
            return true;
        }

        return array_diff($operation->requirements->profiles, $this->profiles) === []
            && array_diff($operation->requirements->capabilities, $this->capabilities) === [];
    }

    /** @param list<mixed> $values @param class-string $class */
    private static function assertTypedList(array $values, string $class): void
    {
        foreach ($values as $value) {
            if (!$value instanceof $class) {
                throw new \InvalidArgumentException('Manifest input contains an invalid definition.');
            }
        }
    }
}
