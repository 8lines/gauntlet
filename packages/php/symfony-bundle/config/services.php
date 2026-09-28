<?php

declare(strict_types=1);

namespace Symfony\Component\DependencyInjection\Loader\Configurator;

use EightLines\Gauntlet\Core\Contract\ExecutionCoordinator;
use EightLines\Gauntlet\Core\Contract\RunDispatcher;
use EightLines\Gauntlet\Core\Contract\RunStore;
use EightLines\Gauntlet\Core\Run\InMemoryExecutionCoordinator;
use EightLines\Gauntlet\Core\Run\InMemoryRunStore;
use EightLines\Gauntlet\Core\Run\InlineRunDispatcher;
use EightLines\Gauntlet\Core\Schema\OpisSchemaValidator;
use EightLines\Gauntlet\Core\Schema\SchemaValidator;
use EightLines\Gauntlet\SymfonyBundle\Capability\CapabilityRegistry;
use EightLines\Gauntlet\SymfonyBundle\Controller\V1\CapabilityAction;
use EightLines\Gauntlet\SymfonyBundle\Controller\V1\CreateRunAction;
use EightLines\Gauntlet\SymfonyBundle\Controller\V1\GetRunAction;
use EightLines\Gauntlet\SymfonyBundle\Controller\V1\HealthAction;
use EightLines\Gauntlet\SymfonyBundle\Controller\V1\ManifestAction;
use EightLines\Gauntlet\SymfonyBundle\Controller\V1\OperationDefinitionAction;
use EightLines\Gauntlet\SymfonyBundle\Controller\V1\QueryDataSourceAction;
use EightLines\Gauntlet\SymfonyBundle\Controller\V1\ResolveDataSourceAction;
use EightLines\Gauntlet\SymfonyBundle\Controller\V1\UnsupportedCapabilityAction;
use EightLines\Gauntlet\SymfonyBundle\EventSubscriber\AdapterPrefixGuardSubscriber;
use EightLines\Gauntlet\SymfonyBundle\Http\CapabilityResponseValidator;
use EightLines\Gauntlet\SymfonyBundle\Http\DataSourceResponseValidator;
use EightLines\Gauntlet\SymfonyBundle\Http\EnvelopeMapper;
use EightLines\Gauntlet\SymfonyBundle\Http\JsonRequestDecoder;
use EightLines\Gauntlet\SymfonyBundle\Http\NativeStreamConnection;
use EightLines\Gauntlet\SymfonyBundle\Http\ProblemResponseFactory;
use EightLines\Gauntlet\SymfonyBundle\Http\ProblemSanitizer;
use EightLines\Gauntlet\SymfonyBundle\Http\ProtocolResponseFactory;
use EightLines\Gauntlet\SymfonyBundle\Http\RawAdapterTargetGuard;
use EightLines\Gauntlet\SymfonyBundle\Http\RunEventStream;
use EightLines\Gauntlet\SymfonyBundle\Http\StreamConnection;
use EightLines\Gauntlet\SymfonyBundle\Input\SymfonyInputMapper;
use EightLines\Gauntlet\SymfonyBundle\Input\SymfonyJsonSchemaFactory;
use EightLines\Gauntlet\SymfonyBundle\Registry\SymfonyAdapterCatalog;
use EightLines\Gauntlet\SymfonyBundle\Registry\SymfonyDataSourceRegistry;
use EightLines\Gauntlet\SymfonyBundle\Registry\SymfonyFeatureRegistry;
use EightLines\Gauntlet\SymfonyBundle\Registry\SymfonyOperationRegistry;
use EightLines\Gauntlet\SymfonyBundle\Run\AdapterRunManager;
use EightLines\Gauntlet\SymfonyBundle\Support\AdapterEnabledGate;

return static function (ContainerConfigurator $container): void {
    $services = $container->services();

    $services->set(OpisSchemaValidator::class);
    $services->alias(SchemaValidator::class, OpisSchemaValidator::class);
    $services->set(InMemoryRunStore::class);
    $services->alias(RunStore::class, InMemoryRunStore::class);
    $services->set(InMemoryExecutionCoordinator::class);
    $services->alias(ExecutionCoordinator::class, InMemoryExecutionCoordinator::class);
    $services->set(InlineRunDispatcher::class);
    $services->alias(RunDispatcher::class, InlineRunDispatcher::class);

    $services->set(SymfonyFeatureRegistry::class)->autowire();
    $services->set(SymfonyOperationRegistry::class)->autowire();
    $services->set(SymfonyDataSourceRegistry::class)->autowire();
    $services->set(CapabilityRegistry::class)->autowire();
    $services->set(SymfonyAdapterCatalog::class)->autowire();
    $services->set(SymfonyJsonSchemaFactory::class);
    $services->set(SymfonyInputMapper::class)->autowire();
    $services->set(AdapterRunManager::class)->autowire();
    $services->set(AdapterEnabledGate::class)->autowire();
    $services->set(NativeStreamConnection::class);
    $services->alias(StreamConnection::class, NativeStreamConnection::class);

    foreach ([
        CapabilityResponseValidator::class,
        DataSourceResponseValidator::class,
        EnvelopeMapper::class,
        JsonRequestDecoder::class,
        ProblemResponseFactory::class,
        ProblemSanitizer::class,
        ProtocolResponseFactory::class,
        RawAdapterTargetGuard::class,
        RunEventStream::class,
    ] as $service) {
        $services->set($service)->autowire();
    }

    $services->set(AdapterPrefixGuardSubscriber::class)
        ->autowire()
        ->tag('kernel.event_subscriber');

    foreach ([
        HealthAction::class,
        ManifestAction::class,
        OperationDefinitionAction::class,
        CreateRunAction::class,
        GetRunAction::class,
        QueryDataSourceAction::class,
        ResolveDataSourceAction::class,
        UnsupportedCapabilityAction::class,
        CapabilityAction::class,
    ] as $controller) {
        $services->set($controller)
            ->autowire()
            ->tag('controller.service_arguments');
    }
};
