<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Integration;

use EightLines\Gauntlet\Core\Contract\CapabilityProvider;
use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Run\Run;
use EightLines\Gauntlet\SymfonyBundle\Capability\CapabilityRegistry;
use EightLines\Gauntlet\SymfonyBundle\Capability\CancelRunEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Capability\SessionLaunchEndpoint;
use PHPUnit\Framework\TestCase;

final class CapabilityRegistryTest extends TestCase
{
    public function testCapabilitiesComeOnlyFromConcreteEndpointSpisAndFutureProviders(): void
    {
        $session = new SessionEndpointFixture();
        $registry = new CapabilityRegistry(
            providers: [new FutureCapabilityFixture('urn-fixture@1')],
            cancelEndpoints: [],
            eventEndpoints: [],
            uploadEndpoints: [],
            sessionLaunchEndpoints: [$session],
        );

        self::assertSame(['tc-session-launch@1', 'urn-fixture@1'], $registry->capabilities());
        self::assertSame($session, $registry->endpoint('tc-session-launch@1'));
        self::assertSame([], $registry->diagnostics());
    }

    public function testGenericProviderCannotClaimCoreCapability(): void
    {
        $registry = new CapabilityRegistry(
            providers: [new FutureCapabilityFixture('tc-run-cancellation@1')],
            cancelEndpoints: [],
            eventEndpoints: [],
            uploadEndpoints: [],
            sessionLaunchEndpoints: [],
        );

        self::assertSame([], $registry->capabilities());
        self::assertSame('core_capability_requires_endpoint_spi', $registry->diagnostics()[0]->code);
    }

    public function testDuplicateSpiIsDiagnosedAndDoesNotAdvertiseOrRoute(): void
    {
        $registry = new CapabilityRegistry(
            providers: [],
            cancelEndpoints: [new CancelEndpointFixture(), new CancelEndpointFixture()],
            eventEndpoints: [],
            uploadEndpoints: [],
            sessionLaunchEndpoints: [],
        );

        self::assertSame([], $registry->capabilities());
        self::assertNull($registry->endpoint('tc-run-cancellation@1'));
        self::assertSame('duplicate_capability_endpoint', $registry->diagnostics()[0]->code);
    }

    public function testDuplicateFutureProviderIsDiagnosedAndRemoved(): void
    {
        $registry = new CapabilityRegistry(
            providers: [
                new FutureCapabilityFixture('urn-fixture@1'),
                new FutureCapabilityFixture('urn-fixture@1'),
            ],
            cancelEndpoints: [],
            eventEndpoints: [],
            uploadEndpoints: [],
            sessionLaunchEndpoints: [],
        );

        self::assertSame([], $registry->capabilities());
        self::assertSame('duplicate_capability_provider', $registry->diagnostics()[0]->code);
    }

    public function testWronglyTaggedObjectCannotAdvertiseACoreCapability(): void
    {
        $registry = new CapabilityRegistry(
            providers: [],
            cancelEndpoints: [new SessionEndpointFixture()],
            eventEndpoints: [new SessionEndpointFixture()],
            uploadEndpoints: [new SessionEndpointFixture()],
            sessionLaunchEndpoints: [new CancelEndpointFixture()],
        );

        self::assertSame([], $registry->capabilities());
        self::assertNull($registry->endpoint('tc-run-cancellation@1'));
        self::assertNull($registry->endpoint('tc-run-sse@1'));
        self::assertNull($registry->endpoint('tc-uploads@1'));
        self::assertNull($registry->endpoint('tc-session-launch@1'));
        self::assertCount(4, $registry->diagnostics());
        self::assertSame('invalid_capability_endpoint', $registry->diagnostics()[0]->code);
        self::assertSame(
            'A capability endpoint does not implement its required SPI.',
            $registry->diagnostics()[0]->message,
        );
        self::assertStringNotContainsString('SessionEndpointFixture', $registry->diagnostics()[0]->message);
    }
}

final readonly class FutureCapabilityFixture implements CapabilityProvider
{
    public function __construct(private string $id)
    {
    }

    public function capabilityId(): string
    {
        return $this->id;
    }
}

final class CancelEndpointFixture implements CancelRunEndpoint
{
    public function cancel(string $runId): Run|Problem
    {
        return new Problem('urn:gauntlet:problem:run-not-found', 'Run not found', 404);
    }
}

final class SessionEndpointFixture implements SessionLaunchEndpoint
{
    public function launch(string $runId, string $artifactId): JsonObject|Problem
    {
        throw new \LogicException('Not called by registry test.');
    }
}
