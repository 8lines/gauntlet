<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\SymfonyBundle\Capability\SessionLaunchEndpoint;

final class FixtureSessionLaunchEndpoint implements SessionLaunchEndpoint
{
    public function launch(string $runId, string $artifactId): JsonObject|Problem
    {
        return JsonOwnership::object([
            'url' => 'https://portal.example.test/session/' . $artifactId,
            'expiresAt' => (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))
                ->modify('+5 minutes')
                ->format('Y-m-d\TH:i:s.u\Z'),
            'singleUse' => true,
        ]);
    }
}
