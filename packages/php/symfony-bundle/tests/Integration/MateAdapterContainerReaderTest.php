<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Integration;

use EightLines\Gauntlet\SymfonyBundle\Mate\AdapterContainerReader;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\EchoOperation;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\FixtureCancelEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\FixtureFeature;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\UsersDataSource;

final class MateAdapterContainerReaderTest extends BundleWebTestCase
{
    public function testItReadsTheAdapterFromTheContainerSymfonyDumped(): void
    {
        self::bootKernel(['environment' => 'capabilities']);
        $cacheDir = dirname(self::$kernel->getCacheDir());
        self::ensureKernelShutdown();

        $report = (new AdapterContainerReader($cacheDir))->read('capabilities');

        self::assertTrue($report['bundle_registered']);
        self::assertTrue($report['enabled']);
        self::assertSame('fixture-app', $report['application']['id'] ?? null);
        self::assertArrayHasKey(EchoOperation::class, $report['services']['operations']['services']);
        self::assertArrayHasKey(FixtureFeature::class, $report['services']['features']['services']);
        self::assertArrayHasKey(UsersDataSource::class, $report['services']['data_sources']['services']);
        self::assertArrayHasKey(FixtureCancelEndpoint::class, $report['services']['cancel_run_endpoints']['services']);
        self::assertStringNotContainsString('fixture-stable-idempotency-secret', json_encode($report, JSON_THROW_ON_ERROR));
    }
}
