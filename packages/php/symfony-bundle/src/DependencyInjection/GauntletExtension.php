<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\DependencyInjection;

use EightLines\Gauntlet\Core\Contract\CapabilityProvider;
use EightLines\Gauntlet\Core\Contract\DataSource;
use EightLines\Gauntlet\Core\Contract\FeatureProvider;
use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletDataSource;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletFeature;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletOperation;
use EightLines\Gauntlet\SymfonyBundle\Capability\CancelRunEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Capability\CapabilityRegistry;
use EightLines\Gauntlet\SymfonyBundle\Capability\RunEventsEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Capability\SessionLaunchEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Capability\UploadEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Support\AdapterConfiguration;
use Symfony\Component\DependencyInjection\ContainerBuilder;
use Symfony\Component\DependencyInjection\Definition;
use Symfony\Component\DependencyInjection\Extension\Extension;
use Symfony\Component\DependencyInjection\Loader\PhpFileLoader;
use Symfony\Component\Config\FileLocator;

final class GauntletExtension extends Extension
{
    /** @param list<array<string, mixed>> $configs */
    public function load(array $configs, ContainerBuilder $container): void
    {
        $configuration = $this->processConfiguration(new Configuration(), $configs);

        $container->setParameter('gauntlet.enabled', $configuration['enabled']);
        $container->setParameter('gauntlet.application', $configuration['application']);
        $container->setParameter('gauntlet.profiles', $configuration['profiles']);

        $container->register(AdapterConfiguration::class, AdapterConfiguration::class)
            ->setArguments([
                $configuration['enabled'],
                $configuration['application']['id'],
                $configuration['application']['label'],
                $configuration['application']['environment']['name'] ?? null,
                $configuration['application']['environment']['kind'] ?? null,
                $configuration['profiles'],
                $configuration['idempotency_secret'],
                $configuration['max_json_bytes'],
            ])
            ->setPublic(true);

        $this->registerAutoconfiguration($container);

        $loader = new PhpFileLoader($container, new FileLocator(dirname(__DIR__, 2) . '/config'));
        $loader->load('services.php');
    }

    public function getAlias(): string
    {
        return 'gauntlet';
    }

    private function registerAutoconfiguration(ContainerBuilder $container): void
    {
        foreach ([
            FeatureProvider::class => FeatureProvider::TAG,
            OperationHandler::class => OperationHandler::TAG,
            DataSource::class => DataSource::TAG,
            CapabilityProvider::class => CapabilityRegistry::PROVIDER_TAG,
            CancelRunEndpoint::class => CancelRunEndpoint::TAG,
            RunEventsEndpoint::class => RunEventsEndpoint::TAG,
            UploadEndpoint::class => UploadEndpoint::TAG,
            SessionLaunchEndpoint::class => SessionLaunchEndpoint::TAG,
        ] as $interface => $tag) {
            $container->registerForAutoconfiguration($interface)->addTag($tag);
        }

        foreach ([
            AsGauntletFeature::class => FeatureProvider::TAG,
            AsGauntletOperation::class => OperationHandler::TAG,
            AsGauntletDataSource::class => DataSource::TAG,
        ] as $attribute => $tag) {
            $container->registerAttributeForAutoconfiguration(
                $attribute,
                static function (Definition $definition) use ($tag): void {
                    $definition->addTag($tag);
                },
            );
        }
    }
}
