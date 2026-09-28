<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Capability;

use EightLines\Gauntlet\Core\Problem\Problem;

interface RunEventsEndpoint
{
    public const TAG = 'gauntlet.capability.run_events';

    /** @return iterable<\EightLines\Gauntlet\Core\Run\RunEvent>|Problem */
    public function events(string $runId, ?string $lastEventId = null): iterable|Problem;
}
