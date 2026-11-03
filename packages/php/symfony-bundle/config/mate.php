<?php

declare(strict_types=1);

namespace Symfony\Component\DependencyInjection\Loader\Configurator;

use EightLines\Gauntlet\SymfonyBundle\Mate\AdapterContainerReader;
use EightLines\Gauntlet\SymfonyBundle\Mate\Capability\AdapterTool;

// Loaded by Symfony AI Mate into its own container, never by the application.
return static function (ContainerConfigurator $container): void {
    $container->parameters()
        ->set('gauntlet.mate.cache_dir', '%mate.root_dir%/var/cache');

    $services = $container->services();
    $services->set(AdapterContainerReader::class)
        ->args(['%gauntlet.mate.cache_dir%']);
    $services->set(AdapterTool::class)
        ->args([service(AdapterContainerReader::class)])
        ->public();
};
