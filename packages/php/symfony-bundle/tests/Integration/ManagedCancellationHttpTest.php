<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Integration;

use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\CapturingRunDispatcher;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\CancellableOperation;

final class ManagedCancellationHttpTest extends BundleWebTestCase
{
    public function testDeferredCreateReturnsQueuedAndManagedEndpointCancelsBeforeExecution(): void
    {
        $client = self::createClient(['environment' => 'managed_cancellation']);
        $client->disableReboot();
        $client->request('GET', '/_gauntlet/v1/manifest');
        self::assertContains(
            'tc-run-cancellation@1',
            $this->responseJson($client->getResponse())['capabilities'],
        );
        $revision = $this->operationRevision($client, 'fixture.cancellable');

        $createdResponse = $this->postJson(
            $client,
            '/_gauntlet/v1/operations/fixture.cancellable/runs',
            [
                'operationRevision' => $revision,
                'input' => new \stdClass(),
                'idempotencyKey' => 'managed-cancel-key',
            ],
        );
        self::assertSame(202, $createdResponse->getStatusCode(), (string) $createdResponse->getContent());
        $created = $this->responseJson($createdResponse);
        self::assertSame('queued', $created['state']);

        $busyResponse = $this->postJson(
            $client,
            '/_gauntlet/v1/operations/fixture.cancellable/runs',
            [
                'operationRevision' => $revision,
                'input' => new \stdClass(),
                'idempotencyKey' => 'managed-busy-key',
            ],
        );
        self::assertSame(409, $busyResponse->getStatusCode());
        self::assertSame([
            'type' => 'urn:gauntlet:problem:operation-busy',
            'title' => 'Operation busy',
            'status' => 409,
        ], $this->responseJson($busyResponse));

        $client->request('POST', '/_gauntlet/v1/runs/' . $created['id'] . '/cancel');
        self::assertResponseStatusCodeSame(202);
        $cancelled = $this->responseJson($client->getResponse());
        self::assertSame('cancelled', $cancelled['state']);
        self::assertSame('urn:gauntlet:problem:run-cancelled', $cancelled['problem']['type']);

        $dispatcher = self::getContainer()->get(CapturingRunDispatcher::class);
        self::assertCount(1, $dispatcher->tasks);
        $dispatcher->tasks[0]->run();
        self::assertSame(0, self::getContainer()->get(CancellableOperation::class)->executions);

        $client->request('GET', '/_gauntlet/v1/runs/' . $created['id']);
        self::assertResponseIsSuccessful();
        self::assertSame($cancelled, $this->responseJson($client->getResponse()));
    }

    public function testManagedEndpointRejectsANonCancellableRunWithoutChangingIt(): void
    {
        $client = self::createClient(['environment' => 'managed_cancellation']);
        $client->disableReboot();
        $revision = $this->operationRevision($client, 'fixture.json-value');
        $createdResponse = $this->postJson(
            $client,
            '/_gauntlet/v1/operations/fixture.json-value/runs',
            [
                'operationRevision' => $revision,
                'input' => ['mode' => 'object'],
            ],
        );
        self::assertSame(202, $createdResponse->getStatusCode());
        $created = $this->responseJson($createdResponse);

        $client->request('POST', '/_gauntlet/v1/runs/' . $created['id'] . '/cancel');

        self::assertResponseStatusCodeSame(409);
        $problem = $this->responseJson($client->getResponse());
        self::assertSame('urn:gauntlet:problem:run-not-cancellable', $problem['type']);
        self::assertSame('Run is not cancellable', $problem['title']);
        self::assertSame(
            'queued',
            self::getContainer()->get(\EightLines\Gauntlet\SymfonyBundle\Run\AdapterRunManager::class)
                ->get($created['id'])?->state->value,
        );
    }

    public function testManagedEndpointFallsBackToOneCustomEndpointOnlyWhenRunIsUnknown(): void
    {
        $client = self::createClient(['environment' => 'managed_cancellation']);
        $client->request('GET', '/_gauntlet/v1/manifest');
        self::assertContains(
            'tc-run-cancellation@1',
            $this->responseJson($client->getResponse())['capabilities'],
        );

        $client->request('POST', '/_gauntlet/v1/runs/run-custom-fallback/cancel');

        self::assertResponseStatusCodeSame(202);
        $fallback = $this->responseJson($client->getResponse());
        self::assertSame('run-custom-fallback', $fallback['id']);
        self::assertSame('running', $fallback['state']);
        self::assertSame('fixture.echo', $fallback['operationId']);
    }
}
