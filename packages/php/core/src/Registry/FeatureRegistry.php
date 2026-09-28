<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Registry;

use EightLines\Gauntlet\Core\Contract\FeatureProvider;
use EightLines\Gauntlet\Core\Definition\FeatureDefinition;

final class FeatureRegistry
{
    /** @var array<string, FeatureDefinition> */
    private array $features = [];

    /** @var list<RegistryDiagnostic> */
    private array $diagnostics = [];

    /** @param iterable<FeatureProvider> $providers */
    public function __construct(iterable $providers)
    {
        foreach ($providers as $provider) {
            try {
                $definition = $provider->definition();
            } catch (\Throwable) {
                $this->diagnostics[] = new RegistryDiagnostic(
                    'invalid_feature_definition',
                    'Feature definition is invalid.',
                );
                continue;
            }
            if (isset($this->features[$definition->id])) {
                $this->diagnostics[] = new RegistryDiagnostic(
                    'duplicate_feature_id',
                    'Duplicate feature ID.',
                );
                continue;
            }
            $this->features[$definition->id] = $definition;
        }
        ksort($this->features, SORT_STRING);
    }

    public function find(string $id): ?FeatureDefinition
    {
        return $this->features[$id] ?? null;
    }

    /** @return list<FeatureDefinition> */
    public function definitions(): array
    {
        return array_values($this->features);
    }

    /** @return list<RegistryDiagnostic> */
    public function diagnostics(): array
    {
        return $this->diagnostics;
    }
}
