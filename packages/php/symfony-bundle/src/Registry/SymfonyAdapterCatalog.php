<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Registry;

use EightLines\Gauntlet\Core\Definition\FeatureDefinition;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Manifest\AdapterManifest;
use EightLines\Gauntlet\Core\Manifest\OperationSummary;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Registry\RegistryDiagnostic;
use EightLines\Gauntlet\Core\Schema\PlacementRules;
use EightLines\Gauntlet\Core\Schema\ProtocolSemantics;
use EightLines\Gauntlet\SymfonyBundle\Capability\CapabilityRegistry;
use EightLines\Gauntlet\SymfonyBundle\Http\ProblemSanitizer;
use EightLines\Gauntlet\SymfonyBundle\Support\AdapterConfiguration;

final class SymfonyAdapterCatalog
{
    /** @var array<string, OperationSummary> */
    private array $summaries = [];

    /** @var array<string, OperationDefinition> */
    private array $definitions = [];

    private ?AdapterManifest $manifest = null;

    public function __construct(
        private readonly AdapterConfiguration $configuration,
        private readonly SymfonyFeatureRegistry $features,
        private readonly SymfonyOperationRegistry $operations,
        private readonly SymfonyDataSourceRegistry $dataSources,
        private readonly CapabilityRegistry $capabilities,
        private readonly ProblemSanitizer $problems,
    ) {
    }

    public function operationSummary(string $operationId): ?OperationSummary
    {
        $this->initialize();

        return $this->summaries[$operationId] ?? null;
    }

    public function operationDefinition(string $operationId): ?OperationDefinition
    {
        $this->initialize();

        return $this->definitions[$operationId] ?? null;
    }

    public function manifest(): AdapterManifest
    {
        $this->initialize();

        return $this->manifest ?? throw new \LogicException('Catalog did not initialize.');
    }

    private function initialize(): void
    {
        if ($this->manifest !== null) {
            return;
        }

        $profiles = array_values(array_unique($this->configuration->profiles));
        sort($profiles, SORT_STRING);
        $capabilities = $this->capabilities->capabilities();
        $profileSet = array_fill_keys($profiles, true);
        $capabilitySet = array_fill_keys($capabilities, true);
        $diagnostics = [
            ...$this->features->diagnostics(),
            ...$this->operations->diagnostics(),
            ...$this->dataSources->diagnostics(),
            ...$this->capabilities->diagnostics(),
        ];
        $features = $this->validFeatures($this->features->definitions(), $diagnostics);
        $featureSet = [];
        foreach ($features as $feature) {
            $featureSet[$feature->id] = true;
        }
        $dataSourceSet = [];
        foreach ($this->dataSources->definitions() as $dataSource) {
            $dataSourceSet[$dataSource->id] = true;
        }
        foreach ($this->operations->definitions() as $definition) {
            if (!ProtocolSemantics::operationSemanticsAreValid($definition)
                || !isset($featureSet[$definition->featureId])
                || $this->hasMissingDataSource($definition, $dataSourceSet)) {
                $diagnostics[] = new RegistryDiagnostic(
                    code: 'invalid_operation_binding',
                    message: 'The operation binding is invalid and was omitted.',
                    operationId: $definition->id,
                );
                continue;
            }

            $this->definitions[$definition->id] = $definition;
            $requirements = $definition->requirements;
            $missingProfiles = array_values(array_filter(
                $requirements?->profiles ?? [],
                static fn (string $profile): bool => !isset($profileSet[$profile]),
            ));
            $missingCapabilities = array_values(array_filter(
                $requirements?->capabilities ?? [],
                static fn (string $capability): bool => !isset($capabilitySet[$capability]),
            ));
            if (($definition->inputHandling?->hasFiles() ?? false)
                && !isset($capabilitySet['tc-uploads@1'])) {
                $missingCapabilities[] = 'tc-uploads@1';
            }
            if ($missingProfiles === [] && $missingCapabilities === []) {
                $summary = OperationSummary::available($definition);
            } else {
                $summary = OperationSummary::unavailable($definition, $this->problems->sanitize(new Problem(
                    type: 'urn:gauntlet:problem:adapter-unavailable',
                    title: 'Operation unavailable',
                    status: 503,
                    detail: 'The operation requirements are not available in this adapter.',
                )));
            }
            $this->summaries[$definition->id] = $summary;
        }
        foreach ($this->operations->definitions() as $definition) {
            if ($definition->placements !== [] && !in_array(PlacementRules::PROFILE, $profiles, true)) {
                $profiles[] = PlacementRules::PROFILE;
            }
        }
        sort($profiles, SORT_STRING);

        ksort($this->summaries, SORT_STRING);
        ksort($this->definitions, SORT_STRING);
        usort($diagnostics, static fn (RegistryDiagnostic $left, RegistryDiagnostic $right): int => [
            $left->code,
            $left->operationId ?? '',
            $left->message,
        ] <=> [
            $right->code,
            $right->operationId ?? '',
            $right->message,
        ]);

        $manifest = new AdapterManifest(
            application: $this->configuration->application(),
            profiles: $profiles,
            capabilities: $capabilities,
            features: $features,
            operations: array_values($this->summaries),
            dataSources: $this->dataSources->definitions(),
            diagnostics: $diagnostics,
        );
        if (!ProtocolSemantics::manifestSemanticsAreValid($manifest)) {
            throw new \LogicException('Adapter manifest violates Gauntlet v1 semantics.');
        }
        $this->manifest = $manifest;
    }

    /**
     * @param list<FeatureDefinition> $features
     * @param list<RegistryDiagnostic> $diagnostics
     * @return list<FeatureDefinition>
     */
    private function validFeatures(array $features, array &$diagnostics): array
    {
        $remaining = [];
        foreach ($features as $feature) {
            $remaining[$feature->id] = $feature;
        }
        $valid = [];
        do {
            $progress = false;
            foreach ($remaining as $id => $feature) {
                if ($feature->parentId !== null && !isset($valid[$feature->parentId])) {
                    continue;
                }
                $valid[$id] = $feature;
                unset($remaining[$id]);
                $progress = true;
            }
        } while ($progress);

        foreach ($remaining as $feature) {
            $diagnostics[] = new RegistryDiagnostic(
                code: 'invalid_feature_binding',
                message: 'The feature hierarchy is invalid and was omitted.',
            );
        }

        return array_values(array_filter(
            $features,
            static fn (FeatureDefinition $feature): bool => isset($valid[$feature->id]),
        ));
    }

    /** @param array<string, true> $dataSourceSet */
    private function hasMissingDataSource(OperationDefinition $definition, array $dataSourceSet): bool
    {
        foreach ($definition->dataSources as $reference) {
            if (!isset($dataSourceSet[$reference->id])) {
                return true;
            }
        }

        return false;
    }
}
