<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Capability;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Problem\Problem;

interface SessionLaunchEndpoint
{
    public const TAG = 'gauntlet.capability.session_launch';

    public function launch(string $runId, string $artifactId): JsonObject|Problem;
}
