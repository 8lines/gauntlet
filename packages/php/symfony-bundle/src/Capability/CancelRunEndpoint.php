<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Capability;

use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Run\Run;

interface CancelRunEndpoint
{
    public const TAG = 'gauntlet.capability.cancel_run';

    public function cancel(string $runId): Run|Problem;
}
