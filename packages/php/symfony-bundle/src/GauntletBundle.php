<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle;

use EightLines\Gauntlet\SymfonyBundle\DependencyInjection\Compiler\TaggedAdapterServicesPass;
use EightLines\Gauntlet\SymfonyBundle\DependencyInjection\GauntletExtension;
use Symfony\Component\DependencyInjection\ContainerBuilder;
use Symfony\Component\DependencyInjection\Extension\ExtensionInterface;
use Symfony\Component\HttpKernel\Bundle\Bundle;

final class GauntletBundle extends Bundle
{
    public function getPath(): string
    {
        return dirname(__DIR__);
    }

    public function build(ContainerBuilder $container): void
    {
        parent::build($container);
        $container->addCompilerPass(new TaggedAdapterServicesPass());
    }

    public function getContainerExtension(): ?ExtensionInterface
    {
        return new GauntletExtension();
    }
}
