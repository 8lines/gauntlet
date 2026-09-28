<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Integration;

use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Protocol\EnvironmentDescriptor;
use EightLines\Gauntlet\Core\Protocol\EnvironmentKind;
use EightLines\Gauntlet\SymfonyBundle\DependencyInjection\GauntletExtension;
use EightLines\Gauntlet\SymfonyBundle\Support\AdapterConfiguration;
use EightLines\Gauntlet\SymfonyBundle\GauntletBundle;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\OperationFixture;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Config\Definition\Exception\InvalidConfigurationException;
use Symfony\Component\DependencyInjection\ContainerBuilder;

final class DependencyInjectionTest extends TestCase
{
    public function testBundleIsDisabledByDefaultAndAutoconfiguresExplicitContracts(): void
    {
        $container = $this->compileContainer([]);

        self::assertFalse($container->get(AdapterConfiguration::class)->enabled);
        self::assertTrue($container->has('fixture.operation'));
        self::assertArrayHasKey(
            OperationHandler::TAG,
            $container->getDefinition('fixture.operation')->getTags(),
        );
    }

    public function testEnabledAdapterRequiresApplicationIdentity(): void
    {
        $this->expectException(InvalidConfigurationException::class);

        $this->compileContainer(['enabled' => true]);
    }

    public function testEnabledAdapterRequiresAnExplicitStableIdempotencySecret(): void
    {
        $this->expectException(InvalidConfigurationException::class);

        $this->compileContainer([
            'enabled' => true,
            'application' => [
                'id' => 'fixture-app',
                'label' => 'Fixture App',
            ],
        ]);
    }

    public function testEnabledAdapterRejectsAShortIdempotencySecret(): void
    {
        $this->expectException(InvalidConfigurationException::class);

        $this->compileContainer([
            'enabled' => true,
            'application' => [
                'id' => 'fixture-app',
                'label' => 'Fixture App',
            ],
            'idempotency_secret' => 'too-short',
        ]);
    }

    /** @dataProvider invalidEnabledEnvironmentConfigurations */
    public function testEnabledAdapterRejectsInvalidEnvironmentConfiguration(array $application): void
    {
        try {
            $this->compileContainer([
                'enabled' => true,
                'application' => $application,
                'idempotency_secret' => 'fixture-stable-idempotency-secret',
            ]);
            self::fail('Invalid enabled environment configuration was accepted.');
        } catch (InvalidConfigurationException $exception) {
            self::assertSame(
                'Invalid configuration for path "gauntlet.application.environment": '
                    . 'Enabled Gauntlet adapter requires a valid non-production application.environment.',
                $exception->getMessage(),
            );
            self::assertSame('gauntlet.application.environment', $exception->getPath());
            foreach ([
                'secret-name-731904',
                'kind-secret-731904',
                'apiToken-731904',
                'secret-value-731904',
            ] as $sentinel) {
                self::assertStringNotContainsString($sentinel, $exception->getMessage());
            }
        }
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function invalidEnabledEnvironmentConfigurations(): iterable
    {
        $identity = ['id' => 'fixture-app', 'label' => 'Fixture App'];

        yield 'missing environment' => [$identity];
        yield 'missing environment name' => [[
            ...$identity,
            'environment' => ['kind' => 'test'],
        ]];
        yield 'missing environment kind' => [[
            ...$identity,
            'environment' => ['name' => 'fixture-test'],
        ]];
        yield 'extra environment member' => [[
            ...$identity,
            'environment' => [
                'name' => 'fixture-test',
                'kind' => 'test',
                'apiToken-731904' => 'secret-value-731904',
            ],
        ]];
        yield 'non-string environment name' => [[
            ...$identity,
            'environment' => ['name' => ['secret-name-731904'], 'kind' => 'test'],
        ]];
        yield 'non-string environment kind' => [[
            ...$identity,
            'environment' => ['name' => 'fixture-test', 'kind' => ['kind-secret-731904']],
        ]];
        yield 'invalid environment name' => [[
            ...$identity,
            'environment' => ['name' => 'unsafe secret-name-731904', 'kind' => 'test'],
        ]];
        yield 'unsupported environment kind' => [[
            ...$identity,
            'environment' => ['name' => 'fixture-test', 'kind' => 'kind-secret-731904'],
        ]];
        yield 'production alias' => [[
            ...$identity,
            'environment' => ['name' => 'fixture-prod-secret-name-731904', 'kind' => 'test'],
        ]];
    }

    public function testEnabledConfigurationKeepsEnvironmentAndValidatedProfiles(): void
    {
        $container = $this->compileContainer([
            'enabled' => true,
            'application' => [
                'id' => 'fixture-app',
                'label' => 'Fixture App',
                'environment' => ['name' => 'fixture-test', 'kind' => 'test'],
            ],
            'profiles' => ['tc-schema-core@1', 'tc-rich-forms@1'],
            'idempotency_secret' => 'fixture-stable-idempotency-secret',
        ]);

        $configuration = $container->get(AdapterConfiguration::class);
        self::assertSame('fixture-app', $configuration->applicationId);
        self::assertSame('Fixture App', $configuration->applicationLabel);
        self::assertEquals(
            new EnvironmentDescriptor('fixture-test', EnvironmentKind::Test),
            $configuration->environment,
        );
        self::assertSame([
            'id' => 'fixture-app',
            'label' => 'Fixture App',
            'environment' => ['name' => 'fixture-test', 'kind' => 'test'],
        ], $configuration->application());
        self::assertSame(['tc-schema-core@1', 'tc-rich-forms@1'], $configuration->profiles);
        self::assertFalse($configuration->hasConfiguredCapabilities());
    }

    /** @param array<string, mixed> $configuration */
    private function compileContainer(array $configuration): ContainerBuilder
    {
        $container = new ContainerBuilder();
        $extension = new GauntletExtension();
        $container->registerExtension($extension);
        $container->loadFromExtension($extension->getAlias(), $configuration);
        $container->register('fixture.operation', OperationFixture::class)
            ->setAutowired(true)
            ->setAutoconfigured(true)
            ->setPublic(true);
        (new GauntletBundle())->build($container);
        $container->compile();

        return $container;
    }
}
