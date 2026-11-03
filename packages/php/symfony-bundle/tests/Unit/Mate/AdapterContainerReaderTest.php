<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Unit\Mate;

use EightLines\Gauntlet\SymfonyBundle\Mate\AdapterContainerReader;
use PHPUnit\Framework\TestCase;

final class AdapterContainerReaderTest extends TestCase
{
    private string $cacheDir;

    protected function setUp(): void
    {
        $this->cacheDir = sys_get_temp_dir() . '/gauntlet-mate-reader-' . bin2hex(random_bytes(6));
        mkdir($this->cacheDir);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->cacheDir . '/*/*') ?: [] as $file) {
            unlink($file);
        }
        foreach (glob($this->cacheDir . '/*') ?: [] as $directory) {
            rmdir($directory);
        }
        rmdir($this->cacheDir);
    }

    public function testItReportsParametersAndGroupsTaggedServices(): void
    {
        $this->dump('dev', <<<'XML'
            <?xml version="1.0" encoding="utf-8"?>
            <container xmlns="http://symfony.com/schema/dic/services">
              <parameters>
                <parameter key="gauntlet.enabled">%env(bool:GAUNTLET_ENABLED)%</parameter>
                <parameter key="gauntlet.application" type="collection">
                  <parameter key="id">billing-api</parameter>
                  <parameter key="label">Billing API</parameter>
                  <parameter key="environment" type="collection">
                    <parameter key="name">billing-staging</parameter>
                    <parameter key="kind">staging</parameter>
                  </parameter>
                </parameter>
                <parameter key="gauntlet.profiles" type="collection">
                  <parameter>tc-schema-core@1</parameter>
                </parameter>
                <parameter key="kernel.secret">must-not-leak</parameter>
              </parameters>
              <services>
                <service id="App\Gauntlet\RefundOperation" class="App\Gauntlet\RefundOperation">
                  <tag name="gauntlet.operation"/>
                </service>
                <service id="App\Gauntlet\BillingFeature" class="App\Gauntlet\BillingFeature">
                  <tag name="gauntlet.feature"/>
                </service>
                <service id="App\Gauntlet\InvoicesDataSource" class="App\Gauntlet\InvoicesDataSource">
                  <tag name="gauntlet.data_source"/>
                </service>
                <service id="App\Gauntlet\Upload" class="App\Gauntlet\Upload">
                  <tag name="gauntlet.capability.upload"/>
                </service>
                <service id="refund" alias="App\Gauntlet\RefundOperation"/>
                <service id="App\Unrelated" class="App\Unrelated"/>
              </services>
            </container>
            XML);

        $report = (new AdapterContainerReader($this->cacheDir))->read();

        self::assertSame('dev', $report['environment']);
        self::assertSame('AppDevDebugContainer.xml', $report['container']);
        self::assertTrue($report['bundle_registered']);
        self::assertSame('%env(bool:GAUNTLET_ENABLED)%', $report['enabled']);
        self::assertSame('GAUNTLET_ENABLED', $report['enabled_env']);
        self::assertSame([
            'id' => 'billing-api',
            'label' => 'Billing API',
            'environment' => ['name' => 'billing-staging', 'kind' => 'staging'],
        ], $report['application']);
        self::assertSame(['tc-schema-core@1'], $report['profiles']);
        self::assertSame(
            ['services' => ['App\Gauntlet\RefundOperation' => 'App\Gauntlet\RefundOperation'], 'count' => 1, 'truncated' => false],
            $report['services']['operations'],
        );
        self::assertSame(['App\Gauntlet\BillingFeature'], array_keys($report['services']['features']['services']));
        self::assertSame(['App\Gauntlet\InvoicesDataSource'], array_keys($report['services']['data_sources']['services']));
        self::assertSame(['App\Gauntlet\Upload'], array_keys($report['services']['upload_endpoints']['services']));
        self::assertSame(0, $report['services']['session_launch_endpoints']['count']);
        self::assertStringNotContainsString('must-not-leak', json_encode($report, JSON_THROW_ON_ERROR));
    }

    public function testItReadsBooleanFlagsAndCapsEachGroup(): void
    {
        $this->dump('test', <<<'XML'
            <?xml version="1.0" encoding="utf-8"?>
            <container xmlns="http://symfony.com/schema/dic/services">
              <parameters>
                <parameter key="gauntlet.enabled">true</parameter>
              </parameters>
              <services>
                <service id="App\A" class="App\A"><tag name="gauntlet.operation"/></service>
                <service id="App\B" class="App\B"><tag name="gauntlet.operation"/></service>
                <service id="App\C" class="App\C"><tag name="gauntlet.operation"/></service>
              </services>
            </container>
            XML);

        $report = (new AdapterContainerReader($this->cacheDir))->read('test', 2);

        self::assertTrue($report['enabled']);
        self::assertArrayNotHasKey('enabled_env', $report);
        self::assertSame(3, $report['services']['operations']['count']);
        self::assertTrue($report['services']['operations']['truncated']);
        self::assertSame(['App\A', 'App\B'], array_keys($report['services']['operations']['services']));
    }

    public function testItSaysWhenTheBundleIsNotRegistered(): void
    {
        $this->dump('dev', <<<'XML'
            <?xml version="1.0" encoding="utf-8"?>
            <container xmlns="http://symfony.com/schema/dic/services">
              <parameters><parameter key="kernel.debug">true</parameter></parameters>
              <services><service id="App\Unrelated" class="App\Unrelated"/></services>
            </container>
            XML);

        self::assertSame(
            ['environment' => 'dev', 'container' => 'AppDevDebugContainer.xml', 'bundle_registered' => false],
            (new AdapterContainerReader($this->cacheDir))->read(),
        );
    }

    public function testItAsksForACacheWarmupWhenNoContainerWasDumped(): void
    {
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('cache:warmup');

        (new AdapterContainerReader($this->cacheDir))->read();
    }

    public function testItRejectsAnEnvironmentThatIsNotAPlainName(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        (new AdapterContainerReader($this->cacheDir))->read('../dev');
    }

    private function dump(string $environment, string $xml): void
    {
        mkdir($this->cacheDir . '/' . $environment);
        $name = 'App' . ucfirst($environment) . 'DebugContainer.xml';
        file_put_contents($this->cacheDir . '/' . $environment . '/' . $name, $xml);
    }
}
