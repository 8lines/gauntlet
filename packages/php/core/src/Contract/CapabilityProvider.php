<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Contract;

interface CapabilityProvider
{
    public function capabilityId(): string;
}
