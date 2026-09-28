<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Capability;

use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Run\Run;

/** Routes owned Runs through Core and delegates unknown IDs to one app endpoint. */
final readonly class ManagedFirstCancelRunEndpoint implements CancelRunEndpoint
{
    public function __construct(
        private ManagedCancelRunEndpoint $managed,
        private CancelRunEndpoint $fallback,
    ) {
    }

    public function cancel(string $runId): Run|Problem
    {
        $result = $this->managed->cancel($runId);
        if ($result instanceof Problem
            && $result->type === 'urn:gauntlet:problem:run-not-found'
            && $result->title === 'Run not found'
            && $result->status === 404) {
            return $this->fallback->cancel($runId);
        }

        return $result;
    }
}
