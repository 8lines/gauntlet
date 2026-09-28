<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Contract\RunStore;
use EightLines\Gauntlet\Core\Contract\RunDispatcher;
use EightLines\Gauntlet\Core\Run\InMemoryRunStore;
use EightLines\Gauntlet\Core\Schema\OpisSchemaValidator;
use EightLines\Gauntlet\Core\Schema\SchemaValidator;
use EightLines\Gauntlet\SymfonyBundle\GauntletBundle;
use EightLines\Gauntlet\SymfonyBundle\Capability\ManagedCancelRunEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Http\StreamConnection;
use Symfony\Bundle\FrameworkBundle\FrameworkBundle;
use Symfony\Bundle\FrameworkBundle\Kernel\MicroKernelTrait;
use Symfony\Component\DependencyInjection\Loader\Configurator\ContainerConfigurator;
use Symfony\Component\HttpKernel\Kernel;
use Symfony\Component\Routing\Loader\Configurator\RoutingConfigurator;

final class FixtureKernel extends Kernel
{
    use MicroKernelTrait;

    public function registerBundles(): iterable
    {
        yield new FrameworkBundle();
        yield new GauntletBundle();
    }

    public function getCacheDir(): string
    {
        return '/tmp/gauntlet-symfony-bundle/cache/' . $this->environment;
    }

    public function getProjectDir(): string
    {
        return '/tmp/gauntlet-symfony-bundle/project';
    }

    public function getLogDir(): string
    {
        return '/tmp/gauntlet-symfony-bundle/log';
    }

    protected function configureContainer(ContainerConfigurator $container): void
    {
        $container->extension('framework', [
            'secret' => 'fixture-secret',
            'test' => true,
            'serializer' => ['enabled' => true],
            'validation' => ['enable_attributes' => true],
            'http_method_override' => false,
        ]);
        $container->extension('gauntlet', $this->gauntletConfiguration());

        $services = $container->services();
        $services->defaults()
            ->autowire()
            ->autoconfigure();

        $services->set(OpisSchemaValidator::class);
        $services->alias(SchemaValidator::class, OpisSchemaValidator::class);
        $services->set(InMemoryRunStore::class)->public();
        $services->alias(RunStore::class, InMemoryRunStore::class);

        foreach ([
            FixtureFeature::class,
            OrphanFeature::class,
            EchoOperation::class,
            JsonValueOperation::class,
            FileOperation::class,
            FailingOperation::class,
            InvalidDefinitionOperation::class,
            MissingProfileOperation::class,
            MissingCapabilityOperation::class,
            MissingFeatureOperation::class,
            MissingDataSourceOperation::class,
            InvalidSemanticsOperation::class,
            UsersDataSource::class,
            RestrictedDataSource::class,
            HostileDataSource::class,
        ] as $service) {
            $services->set($service)->public();
        }

        if ($this->environment === 'capabilities') {
            foreach ([
                FixtureCancelEndpoint::class,
                FixtureEventsEndpoint::class,
                FixtureUploadEndpoint::class,
                FixtureSessionLaunchEndpoint::class,
            ] as $service) {
                $services->set($service)->public();
            }
        }
        if ($this->environment === 'managed_cancellation') {
            $services->set(CancellableOperation::class)->public();
            $services->set(CapturingRunDispatcher::class)->public();
            $services->alias(RunDispatcher::class, CapturingRunDispatcher::class);
            $services->set(ManagedCancelRunEndpoint::class)->public();
            $services->set(FixtureCancelEndpoint::class)->public();
        }
        if ($this->environment === 'throwing_capability') {
            $services->set(ThrowingSessionLaunchEndpoint::class)->public();
        }
        if ($this->environment === 'hostile_capabilities') {
            foreach ([
                HostileCancelEndpoint::class,
                HostileEventsEndpoint::class,
                HostileUploadEndpoint::class,
                HostileSessionLaunchEndpoint::class,
            ] as $service) {
                $services->set($service)->public();
            }
        }
        if ($this->environment === 'disconnecting_events') {
            $services->set(FixtureEventsEndpoint::class)->public();
            $services->set(DisconnectingStreamConnection::class)->public();
            $services->alias(StreamConnection::class, DisconnectingStreamConnection::class);
        }
    }

    protected function configureRoutes(RoutingConfigurator $routes): void
    {
        $routes->import(dirname(__DIR__, 3) . '/config/routes.php');
    }

    /** @return array<string, mixed> */
    private function gauntletConfiguration(): array
    {
        if ($this->environment === 'disabled') {
            return ['enabled' => false];
        }

        return [
            'enabled' => true,
            'application' => [
                'id' => 'fixture-app',
                'label' => 'Fixture App',
                'environment' => [
                    'name' => 'fixture-' . $this->environment,
                    'kind' => 'test',
                ],
            ],
            'profiles' => ['tc-schema-core@1', 'tc-rich-forms@1'],
            'idempotency_secret' => 'fixture-stable-idempotency-secret',
            'max_json_bytes' => 4096,
        ];
    }
}
