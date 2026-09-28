<?php

declare(strict_types=1);

namespace Symfony\Component\Routing\Loader\Configurator;

use EightLines\Gauntlet\SymfonyBundle\Controller\V1\CapabilityAction;
use EightLines\Gauntlet\SymfonyBundle\Controller\V1\CreateRunAction;
use EightLines\Gauntlet\SymfonyBundle\Controller\V1\GetRunAction;
use EightLines\Gauntlet\SymfonyBundle\Controller\V1\HealthAction;
use EightLines\Gauntlet\SymfonyBundle\Controller\V1\ManifestAction;
use EightLines\Gauntlet\SymfonyBundle\Controller\V1\OperationDefinitionAction;
use EightLines\Gauntlet\SymfonyBundle\Controller\V1\QueryDataSourceAction;
use EightLines\Gauntlet\SymfonyBundle\Controller\V1\ResolveDataSourceAction;

return static function (RoutingConfigurator $routes): void {
    $id = '[A-Za-z0-9][A-Za-z0-9._:-]{0,127}';

    $routes->add('gauntlet_v1_health', '/_gauntlet/v1/health')
        ->controller(HealthAction::class)
        ->methods(['GET']);
    $routes->add('gauntlet_v1_manifest', '/_gauntlet/v1/manifest')
        ->controller(ManifestAction::class)
        ->methods(['GET']);
    $routes->add('gauntlet_v1_operation', '/_gauntlet/v1/operations/{operationId}')
        ->controller(OperationDefinitionAction::class)
        ->requirements(['operationId' => $id])
        ->methods(['GET']);
    $routes->add('gauntlet_v1_create_run', '/_gauntlet/v1/operations/{operationId}/runs')
        ->controller(CreateRunAction::class)
        ->requirements(['operationId' => $id])
        ->methods(['POST']);
    $routes->add('gauntlet_v1_get_run', '/_gauntlet/v1/runs/{runId}')
        ->controller(GetRunAction::class)
        ->requirements(['runId' => $id])
        ->methods(['GET']);
    $routes->add('gauntlet_v1_query_data_source', '/_gauntlet/v1/data-sources/{dataSourceId}/query')
        ->controller(QueryDataSourceAction::class)
        ->requirements(['dataSourceId' => $id])
        ->methods(['POST']);
    $routes->add('gauntlet_v1_resolve_data_source', '/_gauntlet/v1/data-sources/{dataSourceId}/resolve')
        ->controller(ResolveDataSourceAction::class)
        ->requirements(['dataSourceId' => $id])
        ->methods(['POST']);

    $routes->add('gauntlet_v1_cancel_run', '/_gauntlet/v1/runs/{runId}/cancel')
        ->controller(CapabilityAction::class)
        ->defaults(['capability' => 'tc-run-cancellation@1'])
        ->requirements(['runId' => $id])
        ->methods(['POST']);
    $routes->add('gauntlet_v1_run_events', '/_gauntlet/v1/runs/{runId}/events')
        ->controller(CapabilityAction::class)
        ->defaults(['capability' => 'tc-run-sse@1'])
        ->requirements(['runId' => $id])
        ->methods(['GET']);
    $routes->add('gauntlet_v1_upload', '/_gauntlet/v1/uploads')
        ->controller(CapabilityAction::class)
        ->defaults(['capability' => 'tc-uploads@1'])
        ->methods(['POST']);
    $routes->add('gauntlet_v1_session_launch', '/_gauntlet/v1/runs/{runId}/artifacts/{artifactId}/launch')
        ->controller(CapabilityAction::class)
        ->defaults(['capability' => 'tc-session-launch@1'])
        ->requirements(['runId' => $id, 'artifactId' => $id])
        ->methods(['POST']);
};
