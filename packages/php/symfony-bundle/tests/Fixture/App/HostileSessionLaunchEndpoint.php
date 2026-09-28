<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Problem\ValidationError;
use EightLines\Gauntlet\SymfonyBundle\Capability\SessionLaunchEndpoint;

final class HostileSessionLaunchEndpoint implements SessionLaunchEndpoint
{
    public function launch(string $runId, string $artifactId): JsonObject|Problem
    {
        $valid = [
            'url' => 'https://portal.example.test/session',
            'expiresAt' => '2099-01-01T00:00:00Z',
            'singleUse' => true,
        ];

        return match ($artifactId) {
            'missing' => new JsonObject(array_diff_key($valid, ['expiresAt' => true])),
            'extra' => new JsonObject([...$valid, 'private' => 'session-secret-731904']),
            'scalar' => new JsonObject([...$valid, 'singleUse' => 'true']),
            'expired' => new JsonObject([...$valid, 'expiresAt' => '2000-01-01T00:00:00Z']),
            'too-long' => new JsonObject([
                ...$valid,
                'expiresAt' => (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))
                    ->modify('+16 minutes')
                    ->format('Y-m-d\TH:i:s.u\Z'),
            ]),
            'invalid-time' => new JsonObject([...$valid, 'expiresAt' => '2099-02-30T00:00:00Z']),
            'credentials' => new JsonObject([...$valid, 'url' => 'https://user:password@portal.example.test/session']),
            'scheme' => new JsonObject([...$valid, 'url' => 'javascript:alert(1)']),
            'sensitive-problem' => new Problem(
                type: 'urn:gauntlet:problem:validation-failed',
                title: 'private title 731904',
                status: 422,
                detail: 'private detail 731904',
                instance: '/private/731904',
                correlationId: 'private-correlation-731904',
                errors: [new ValidationError(
                    instancePath: "unsafe\n731904",
                    schemaPath: 'unsafe-731904',
                    keyword: "unsafe\n731904",
                    message: 'private validation message 731904',
                    params: JsonOwnership::object(['private' => '731904']),
                ), new ValidationError(
                    instancePath: "/\xFF",
                    schemaPath: "#/\xFF",
                    keyword: "\xFF",
                    message: 'private invalid UTF-8 731904',
                    params: JsonOwnership::object([]),
                )],
            ),
            'unknown-problem' => new Problem(
                type: 'urn:gauntlet:problem:private-domain-error',
                title: 'private title 731904',
                status: 418,
                detail: 'private detail 731904',
            ),
            'wrong-capability' => new Problem(
                type: 'urn:gauntlet:problem:unsupported-capability',
                title: 'private capability 731904',
                status: 501,
                capability: 'tc-uploads@1',
            ),
            default => new JsonObject($valid),
        };
    }
}
