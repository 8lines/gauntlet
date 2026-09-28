<?php

declare(strict_types=1);

namespace Symfony\Component\DependencyInjection\Loader\Configurator;

use EightLines\Gauntlet\Core\Contract\RunStore;
use EightLines\Gauntlet\Core\Schema\OpisSchemaValidator;
use EightLines\Gauntlet\Core\Schema\SchemaValidator;
use Gauntlet\SymfonyExample\Gauntlet\FinalizeAgencyApplicationOperation;
use Gauntlet\SymfonyExample\Gauntlet\SqliteRunStore;

return static function (ContainerConfigurator $container): void {
    $services = $container->services();
    $services->defaults()
        ->autowire()
        ->autoconfigure();

    $services->load('Gauntlet\\SymfonyExample\\', __DIR__ . '/../src/')
        ->exclude(__DIR__ . '/../src/Kernel.php');

    $services->set(OpisSchemaValidator::class);
    $services->alias(SchemaValidator::class, OpisSchemaValidator::class);
    $services->set(SqliteRunStore::class)
        ->arg('$path', '%gauntlet_example.run_store_path%');
    $services->alias(RunStore::class, SqliteRunStore::class);

    $services->get(FinalizeAgencyApplicationOperation::class)->public();
};
