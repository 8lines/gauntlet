<?php

declare(strict_types=1);

namespace Gauntlet\SymfonyExample;

use Symfony\Bundle\FrameworkBundle\Kernel\MicroKernelTrait;
use Symfony\Component\DependencyInjection\Loader\Configurator\ContainerConfigurator;
use Symfony\Component\HttpKernel\Kernel as BaseKernel;
use Symfony\Component\Routing\Loader\Configurator\RoutingConfigurator;

final class Kernel extends BaseKernel
{
    use MicroKernelTrait;

    public function getCacheDir(): string
    {
        return '/tmp/gauntlet-symfony-example/cache/' . $this->environment;
    }

    public function getLogDir(): string
    {
        return '/tmp/gauntlet-symfony-example/log';
    }

    protected function configureContainer(ContainerConfigurator $container): void
    {
        $container->parameters()->set(
            'gauntlet_example.run_store_path',
            $this->runStorePath(),
        );
        $container->extension('framework', [
            'secret' => false,
            'test' => $this->environment !== 'prod',
            'serializer' => ['enabled' => true],
            'validation' => ['enable_attributes' => true],
            'http_method_override' => false,
        ]);
        $container->extension('gauntlet', $this->gauntletConfiguration());
        $container->import($this->getProjectDir() . '/config/services.php');
    }

    protected function configureRoutes(RoutingConfigurator $routes): void
    {
        $routes->import($this->getProjectDir() . '/config/routes.php');
    }

    /** @return array<string, mixed> */
    private function gauntletConfiguration(): array
    {
        $enabled = $_SERVER['GAUNTLET_ENABLED']
            ?? $_ENV['GAUNTLET_ENABLED']
            ?? getenv('GAUNTLET_ENABLED');
        if ($this->environment === 'disabled' || $enabled !== 'true') {
            return ['enabled' => false];
        }

        return [
            'enabled' => true,
            'application' => [
                'id' => 'symfony-example',
                'label' => 'Symfony Gauntlet example',
                'environment' => [
                    'name' => 'symfony-example-test',
                    'kind' => 'test',
                ],
            ],
            'profiles' => ['tc-schema-core@1', 'tc-rich-forms@1', 'tc-rich-results@1'],
            'idempotency_secret' => $this->idempotencySecret(),
            'max_json_bytes' => 65_536,
        ];
    }

    private function idempotencySecret(): string
    {
        $configured = $_SERVER['GAUNTLET_IDEMPOTENCY_SECRET']
            ?? $_ENV['GAUNTLET_IDEMPOTENCY_SECRET']
            ?? getenv('GAUNTLET_IDEMPOTENCY_SECRET');

        return is_string($configured) ? $configured : '';
    }

    private function runStorePath(): string
    {
        $configured = $_SERVER['GAUNTLET_RUN_STORE_PATH']
            ?? $_ENV['GAUNTLET_RUN_STORE_PATH']
            ?? getenv('GAUNTLET_RUN_STORE_PATH');
        if (is_string($configured) && $configured !== '') {
            return $configured;
        }

        return '/tmp/gauntlet-symfony-example/runs-' . $this->environment . '.sqlite';
    }
}
