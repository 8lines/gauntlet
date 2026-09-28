<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\DependencyInjection\Compiler;

use EightLines\Gauntlet\Core\Contract\DataSource;
use EightLines\Gauntlet\Core\Contract\FeatureProvider;
use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\SymfonyBundle\Capability\CancelRunEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Capability\CapabilityRegistry;
use EightLines\Gauntlet\SymfonyBundle\Capability\RunEventsEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Capability\SessionLaunchEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Capability\UploadEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Registry\SymfonyDataSourceRegistry;
use EightLines\Gauntlet\SymfonyBundle\Registry\SymfonyFeatureRegistry;
use EightLines\Gauntlet\SymfonyBundle\Registry\SymfonyOperationRegistry;
use Symfony\Component\DependencyInjection\Argument\TaggedIteratorArgument;
use Symfony\Component\DependencyInjection\Compiler\CompilerPassInterface;
use Symfony\Component\DependencyInjection\ContainerBuilder;

final class TaggedAdapterServicesPass implements CompilerPassInterface
{
    public function process(ContainerBuilder $container): void
    {
        $this->setTaggedArgument($container, SymfonyFeatureRegistry::class, FeatureProvider::TAG);
        $this->setTaggedArgument($container, SymfonyOperationRegistry::class, OperationHandler::TAG);
        $this->setTaggedArgument($container, SymfonyDataSourceRegistry::class, DataSource::TAG);
        if ($container->hasDefinition(\EightLines\Gauntlet\SymfonyBundle\Run\AdapterRunManager::class)) {
            $container->getDefinition(\EightLines\Gauntlet\SymfonyBundle\Run\AdapterRunManager::class)
                ->setArgument('$uploadEndpoints', new TaggedIteratorArgument(UploadEndpoint::TAG));
        }

        if ($container->hasDefinition(CapabilityRegistry::class)) {
            $container->getDefinition(CapabilityRegistry::class)->setArguments([
                new TaggedIteratorArgument(CapabilityRegistry::PROVIDER_TAG),
                new TaggedIteratorArgument(CancelRunEndpoint::TAG),
                new TaggedIteratorArgument(RunEventsEndpoint::TAG),
                new TaggedIteratorArgument(UploadEndpoint::TAG),
                new TaggedIteratorArgument(SessionLaunchEndpoint::TAG),
            ]);
        }
    }

    private function setTaggedArgument(ContainerBuilder $container, string $service, string $tag): void
    {
        if ($container->hasDefinition($service)) {
            $container->getDefinition($service)->setArgument(0, new TaggedIteratorArgument($tag));
        }
    }
}
