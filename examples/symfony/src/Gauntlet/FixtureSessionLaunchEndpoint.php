<?php

declare(strict_types=1);

namespace Gauntlet\SymfonyExample\Gauntlet;

use EightLines\Gauntlet\Core\Contract\RunStore;
use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\SymfonyBundle\Capability\SessionLaunchEndpoint;

final readonly class FixtureSessionLaunchEndpoint implements SessionLaunchEndpoint
{
    public function __construct(private RunStore $runs)
    {
    }

    public function launch(string $runId, string $artifactId): JsonObject|Problem
    {
        $run = $this->runs->get($runId);
        if ($run === null) {
            return new Problem(
                type: 'urn:gauntlet:problem:run-not-found',
                title: 'Run not found',
                status: 404,
            );
        }
        if ($artifactId !== 'conformance-browser-session') {
            return new Problem(
                type: 'urn:gauntlet:problem:artifact-not-found',
                title: 'Artifact not found',
                status: 404,
            );
        }

        return JsonOwnership::object([
            'url' => 'https://portal.example.test/gauntlet/session/' . bin2hex(random_bytes(16)),
            'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', time() + 300),
            'singleUse' => true,
        ]);
    }
}
