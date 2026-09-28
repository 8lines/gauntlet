<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Capability;

use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Run\Run;
use EightLines\Gauntlet\SymfonyBundle\Run\AdapterRunManager;

/** Opt-in bridge from the cancellation capability to the Core run manager. */
final readonly class ManagedCancelRunEndpoint implements CancelRunEndpoint
{
    public function __construct(private AdapterRunManager $runs)
    {
    }

    public function cancel(string $runId): Run|Problem
    {
        return $this->runs->cancel($runId);
    }
}
