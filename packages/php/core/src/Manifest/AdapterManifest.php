<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Manifest;

use EightLines\Gauntlet\Core\Definition\DataSourceDefinition;
use EightLines\Gauntlet\Core\Definition\FeatureDefinition;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Json\Rfc8785CanonicalJson;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Registry\RegistryDiagnostic;
use EightLines\Gauntlet\Core\Schema\TcSchemaCore;

final readonly class AdapterManifest
{
    /**
     * @param array{id: string, label: string, environment: array{name: string, kind: string}} $application
     * @param list<string> $profiles
     * @param list<string> $capabilities
     * @param list<FeatureDefinition> $features
     * @param list<OperationSummary> $operations
     * @param list<DataSourceDefinition> $dataSources
     * @param list<RegistryDiagnostic> $diagnostics
     */
    public function __construct(
        public array $application,
        public array $profiles,
        public array $capabilities,
        public array $features,
        public array $operations,
        public array $dataSources,
        public array $diagnostics = [],
        public ?ProtocolExtensions $extensions = null,
    ) {
    }

    public function revision(): string
    {
        return Rfc8785CanonicalJson::revision(
            JsonOwnership::object($this->toProtocolArray(false)),
            'manifestRevision',
        );
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(bool $withRevision = true): array
    {
        $document = [
            'protocolVersion' => '1.0',
            'schemaDialect' => TcSchemaCore::DIALECT,
            'profiles' => $this->profiles,
            'capabilities' => $this->capabilities,
            'application' => $this->application,
            'features' => array_map(
                static fn (FeatureDefinition $feature): array => $feature->toProtocolArray(),
                $this->features,
            ),
            'operations' => array_map(
                static fn (OperationSummary $operation): array => $operation->toProtocolArray(),
                $this->operations,
            ),
            'dataSources' => array_map(
                static fn (DataSourceDefinition $source): array => $source->toProtocolArray(),
                $this->dataSources,
            ),
        ];
        if ($this->diagnostics !== []) {
            $document['diagnostics'] = array_map(
                static fn (RegistryDiagnostic $diagnostic): array => $diagnostic->toProtocolArray(),
                $this->diagnostics,
            );
        }
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }
        if ($withRevision) {
            $document['manifestRevision'] = $this->revision();
        }

        return $document;
    }
}
