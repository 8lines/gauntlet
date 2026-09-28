<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\SymfonyBundle\Capability\SessionLaunchEndpoint;

final class ThrowingSessionLaunchEndpoint implements SessionLaunchEndpoint
{
    public function launch(string $runId, string $artifactId): JsonObject|Problem
    {
        throw new \RuntimeException('private capability failure with secret 731904');
    }
}
