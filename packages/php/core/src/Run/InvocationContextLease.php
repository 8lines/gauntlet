<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

final class InvocationContextLease
{
    private ?InvocationContext $context;

    public function __construct(?InvocationContext $context)
    {
        $this->context = $context;
    }

    public function get(): ?InvocationContext
    {
        return $this->context;
    }

    public function close(): void
    {
        $this->context = null;
    }
}
