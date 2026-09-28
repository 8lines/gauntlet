<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Registry;

use EightLines\Gauntlet\Core\Contract\DataSource;
use EightLines\Gauntlet\Core\Definition\DataSourceDefinition;
use EightLines\Gauntlet\Core\Registry\DataSourceRegistry;
use EightLines\Gauntlet\Core\Registry\RegistryDiagnostic;

final class SymfonyDataSourceRegistry
{
    private readonly DataSourceRegistry $inner;

    public function __construct(iterable $sources)
    {
        $this->inner = new DataSourceRegistry($sources);
    }

    public function find(string $id): ?DataSource
    {
        return $this->inner->find($id);
    }

    /** @return list<DataSourceDefinition> */
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
