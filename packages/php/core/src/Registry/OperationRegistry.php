<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Registry;

use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;

final class OperationRegistry
{
    /** @var array<string, OperationHandler> */
    private array $handlers = [];

    /** @var array<string, OperationDefinition> */
    private array $definitions = [];

    /** @var list<RegistryDiagnostic> */
    private array $diagnostics = [];

    /** @param iterable<OperationHandler> $handlers */
    public function __construct(iterable $handlers)
    {
        foreach ($handlers as $handler) {
            try {
                $definition = $handler->definition();
            } catch (\Throwable) {
                $this->diagnostics[] = new RegistryDiagnostic(
                    'invalid_operation_definition',
                    'Operation definition is invalid.',
                );
                continue;
            }
            if (isset($this->handlers[$definition->id])) {
                $this->diagnostics[] = new RegistryDiagnostic(
                    'duplicate_operation_id',
                    'Duplicate operation ID.',
                    operationId: $definition->id,
                );
                continue;
            }
            $this->handlers[$definition->id] = $handler;
            $this->definitions[$definition->id] = $definition;
        }
        ksort($this->handlers, SORT_STRING);
        ksort($this->definitions, SORT_STRING);
    }

    public function find(string $id): ?OperationHandler
    {
        return $this->handlers[$id] ?? null;
    }

    public function definition(string $id): ?OperationDefinition
    {
        return $this->definitions[$id] ?? null;
    }

    /** @return list<OperationDefinition> */
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
