<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Registry;

use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Registry\OperationRegistry;
use EightLines\Gauntlet\Core\Registry\RegistryDiagnostic;

final class SymfonyOperationRegistry
{
    private readonly OperationRegistry $inner;

    public function __construct(iterable $handlers)
    {
        $this->inner = new OperationRegistry($handlers);
    }

    public function find(string $id): ?OperationHandler
    {
        return $this->inner->find($id);
    }

    /** @return list<OperationDefinition> */
    public function definitions(): array
    {
        return $this->inner->definitions();
    }

    /** @return list<RegistryDiagnostic> */
    public function diagnostics(): array
    {
        return $this->inner->diagnostics();
    }

    public function core(): OperationRegistry
    {
        return $this->inner;
    }
}
