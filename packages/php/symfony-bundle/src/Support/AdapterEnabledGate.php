<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Support;

final readonly class AdapterEnabledGate
{
    public function __construct(private AdapterConfiguration $configuration)
    {
    }

    public function isEnabled(): bool
    {
        return $this->configuration->enabled;
    }
}
