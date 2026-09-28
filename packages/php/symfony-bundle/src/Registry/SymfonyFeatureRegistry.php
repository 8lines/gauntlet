<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Registry;

use EightLines\Gauntlet\Core\Definition\FeatureDefinition;
use EightLines\Gauntlet\Core\Registry\FeatureRegistry;
use EightLines\Gauntlet\Core\Registry\RegistryDiagnostic;

final class SymfonyFeatureRegistry
{
    private readonly FeatureRegistry $inner;

    public function __construct(iterable $providers)
    {
        $this->inner = new FeatureRegistry($providers);
    }

    public function find(string $id): ?FeatureDefinition
    {
        return $this->inner->find($id);
    }

    /** @return list<FeatureDefinition> */
    public function definitions(): array
    {
        return $this->inner->definitions();
    }

    /** @return list<RegistryDiagnostic> */
    public function diagnostics(): array
    {
        return $this->inner->diagnostics();
    }
}
