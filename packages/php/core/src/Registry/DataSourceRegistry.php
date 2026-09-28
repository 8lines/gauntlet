<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Registry;

use EightLines\Gauntlet\Core\Contract\DataSource;
use EightLines\Gauntlet\Core\Definition\DataSourceDefinition;

final class DataSourceRegistry
{
    /** @var array<string, DataSource> */
    private array $sources = [];

    /** @var array<string, DataSourceDefinition> */
    private array $definitions = [];

    /** @var list<RegistryDiagnostic> */
    private array $diagnostics = [];

    /** @param iterable<DataSource> $sources */
    public function __construct(iterable $sources)
    {
        foreach ($sources as $source) {
            try {
                $definition = $source->definition();
            } catch (\Throwable) {
                $this->diagnostics[] = new RegistryDiagnostic(
                    'invalid_data_source_definition',
                    'Data source definition is invalid.',
                );
                continue;
            }
            if (isset($this->sources[$definition->id])) {
                $this->diagnostics[] = new RegistryDiagnostic(
                    'duplicate_data_source_id',
                    'Duplicate data source ID.',
                );
                continue;
            }
            $this->sources[$definition->id] = $source;
            $this->definitions[$definition->id] = $definition;
        }
        ksort($this->sources, SORT_STRING);
        ksort($this->definitions, SORT_STRING);
    }

    public function find(string $id): ?DataSource
    {
        return $this->sources[$id] ?? null;
    }

    /** @return list<DataSourceDefinition> */
    public function definitions(): array
    {
        return array_values($this->definitions);
    }

    /** @return list<RegistryDiagnostic> */
    public function diagnostics(): array
    {
        return $this->diagnostics;
    }
}
