<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Integration;

use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\FileOperation;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\DisconnectingStreamConnection;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\FixtureEventsEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\FixtureUploadEndpoint;
use Symfony\Component\HttpFoundation\File\UploadedFile;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\StreamedResponse;

final class AdvertisedCapabilityHttpTest extends BundleWebTestCase
{
    public function testEveryInstalledOptionalSpiIsAdvertisedAndDispatched(): void
    {
        $client = self::createClient(['environment' => 'capabilities']);
        $client->disableReboot();
        $client->request('GET', '/_gauntlet/v1/manifest');
        self::assertSame(
            ['tc-run-cancellation@1', 'tc-run-sse@1', 'tc-session-launch@1', 'tc-uploads@1'],
            $this->responseJson($client->getResponse())['capabilities'],
        );

        $client->request('POST', '/_gauntlet/v1/runs/run-1/cancel');
        self::assertResponseStatusCodeSame(202);
        $cancelled = $this->responseJson($client->getResponse());
        self::assertSame('running', $cancelled['state']);
        self::assertSame($this->operationRevision($client), $cancelled['operationRevision']);

        $client->request(
            'GET',
            '/_gauntlet/v1/runs/run-1/events',
            server: ['HTTP_LAST_EVENT_ID' => 'event-previous'],
        );
        self::assertResponseIsSuccessful();
        self::assertResponseHeaderSame('Content-Type', 'text/event-stream; charset=UTF-8');
        self::assertStringContainsString(
            "id: event-1\nevent: run.updated\n",
            $client->getInternalResponse()->getContent(),
        );
        self::assertSame(
            'event-previous',
            self::getContainer()->get(FixtureEventsEndpoint::class)->lastEventId,
        );

        $client->request(
            'GET',
            '/_gauntlet/v1/runs/run-1/events',
            server: ['HTTP_LAST_EVENT_ID' => "unsafe event\n731904"],
        );
        self::assertResponseStatusCodeSame(422);
        self::assertSame(1, self::getContainer()->get(FixtureEventsEndpoint::class)->invocations);

        $temporaryFile = tempnam(sys_get_temp_dir(), 'tc-upload-');
        self::assertIsString($temporaryFile);
        file_put_contents($temporaryFile, 'fixture');
        try {
            $client->request('POST', '/_gauntlet/v1/uploads', files: [
                'file' => new UploadedFile($temporaryFile, 'fixture.txt', 'text/plain', test: true),
            ]);
            self::assertResponseStatusCodeSame(201);
            self::assertSame('fixture-upload', $this->responseJson($client->getResponse())['file']['uploadId']);
        } finally {
            if (is_file($temporaryFile)) {
                unlink($temporaryFile);
            }
        }

        $client->request('GET', '/_gauntlet/v1/operations/fixture.file');
        $revision = $this->responseJson($client->getResponse())['revision'];
        $file = [
            'kind' => 'file',
            'uploadId' => 'fixture-upload',
            'name' => 'fixture.txt',
            'mediaType' => 'text/plain',
            'sizeBytes' => 7,
            'expiresAt' => '2099-01-01T00:00:00Z',
        ];
        $created = $this->postJson($client, '/_gauntlet/v1/operations/fixture.file/runs', [
            'operationRevision' => $revision,
            'input' => ['attachment' => $file],
            'confirmation' => [
                'operationId' => 'fixture.file',
                'operationRevision' => $revision,
                'impact' => 'write',
                'extensions' => ['urn:fixture:confirmation' => true],
            ],
        ]);
        self::assertSame(201, $created->getStatusCode());
        self::assertSame('succeeded', $this->responseJson($created)['state']);
        self::assertSame(1, self::getContainer()->get(FileOperation::class)->executions);
        $uploads = self::getContainer()->get(FixtureUploadEndpoint::class);
        self::assertSame(1, $uploads->validationCalls);
        self::assertSame('fixture.file', $uploads->validatedOperationId);
        self::assertSame($revision, $uploads->validatedRevision);

        $file['uploadId'] = 'not-issued-by-this-adapter';
        $rejected = $this->postJson($client, '/_gauntlet/v1/operations/fixture.file/runs', [
            'operationRevision' => $revision,
            'input' => ['attachment' => $file],
            'confirmation' => [
                'operationId' => 'fixture.file',
                'operationRevision' => $revision,
                'impact' => 'write',
            ],
        ]);
        self::assertSame(422, $rejected->getStatusCode());
        self::assertSame(1, self::getContainer()->get(FileOperation::class)->executions);
        self::assertSame(2, $uploads->validationCalls);

        $client->request('POST', '/_gauntlet/v1/runs/run-1/artifacts/artifact-1/launch');
        self::assertResponseStatusCodeSame(201);
        self::assertSame(
            'https://portal.example.test/session/artifact-1',
            $this->responseJson($client->getResponse())['url'],
        );
    }

    public function testThrowingCapabilityIsNormalizedWithoutExceptionOrSecret(): void
    {
        $client = self::createClient(['environment' => 'throwing_capability']);
        $client->request('POST', '/_gauntlet/v1/runs/run-1/artifacts/artifact-1/launch');

        self::assertResponseStatusCodeSame(500);
        self::assertResponseHeaderSame('Content-Type', 'application/problem+json');
        $body = (string) $client->getResponse()->getContent();
        $problem = $this->responseJson($client->getResponse());
        self::assertSame('urn:gauntlet:problem:adapter-internal-error', $problem['type']);
        self::assertSame(500, $problem['status']);
        self::assertStringStartsWith('tc-', $problem['correlationId']);
        self::assertStringNotContainsString('731904', $body);
        self::assertStringNotContainsString('RuntimeException', $body);
        self::assertStringNotContainsString('private capability failure', $body);
    }

    public function testHostileCapabilityDocumentsAndIteratorsFailClosed(): void
    {
        $client = self::createClient(['environment' => 'hostile_capabilities']);

        foreach ([
            'missing',
            'extra',
            'scalar',
            'expired',
            'too-long',
            'invalid-time',
            'credentials',
            'scheme',
        ] as $artifactId) {
            $client->request(
                'POST',
                '/_gauntlet/v1/runs/run-1/artifacts/' . $artifactId . '/launch',
            );
            $this->assertSafeCapabilityFailure($client->getResponse());
        }

        foreach (['missing.txt', 'extra.txt', 'scalar.txt'] as $name) {
            $temporaryFile = tempnam(sys_get_temp_dir(), 'tc-hostile-upload-');
            self::assertIsString($temporaryFile);
            file_put_contents($temporaryFile, 'x');
            try {
                $client->request('POST', '/_gauntlet/v1/uploads', files: [
                    'file' => new UploadedFile($temporaryFile, $name, 'text/plain', test: true),
                ]);
                $this->assertSafeCapabilityFailure($client->getResponse());
            } finally {
                if (is_file($temporaryFile)) {
                    unlink($temporaryFile);
                }
            }
        }

        foreach (['wrong-shape', 'unsafe-event', 'mismatched-event', 'iterator-throw'] as $runId) {
            $client->request('GET', '/_gauntlet/v1/runs/' . $runId . '/events');
            self::assertResponseIsSuccessful();
            self::assertResponseHeaderSame('Content-Type', 'text/event-stream; charset=UTF-8');
            self::assertSame('', $client->getInternalResponse()->getContent());
        }
    }

    public function testCapabilityProblemsUseOnlySafeClosedTransportFields(): void
    {
        $client = self::createClient(['environment' => 'hostile_capabilities']);

        $client->request(
            'POST',
            '/_gauntlet/v1/runs/run-1/artifacts/sensitive-problem/launch',
        );
        self::assertResponseStatusCodeSame(422);
        self::assertSame([
            'type' => 'urn:gauntlet:problem:validation-failed',
            'title' => 'Validation failed',
            'status' => 422,
            'errors' => [[
                'instancePath' => '',
                'schemaPath' => '#',
                'keyword' => 'validation',
                'message' => 'Value does not satisfy schema.',
                'params' => [],
            ], [
                'instancePath' => '',
                'schemaPath' => '#',
                'keyword' => 'validation',
                'message' => 'Value does not satisfy schema.',
                'params' => [],
            ]],
        ], $this->responseJson($client->getResponse()));
        self::assertStringNotContainsString('731904', (string) $client->getResponse()->getContent());

        foreach (['unknown-problem', 'wrong-capability'] as $artifactId) {
            $client->request(
                'POST',
                '/_gauntlet/v1/runs/run-1/artifacts/' . $artifactId . '/launch',
            );
            $this->assertSafeCapabilityFailure($client->getResponse());
        }
    }

    public function testCapabilityRunsAreCoupledToRequestedIdentityAndCatalogDefinitions(): void
    {
        $client = self::createClient(['environment' => 'hostile_capabilities']);

        foreach (['wrong-id', 'wrong-revision', 'invalid-output', 'invalid-action', 'invalid-progress'] as $runId) {
            $client->request('POST', '/_gauntlet/v1/runs/' . $runId . '/cancel');
            $this->assertSafeCapabilityFailure($client->getResponse());
        }

        foreach ([
            'scalar-output' => 'done',
            'list-output' => [1, 'two'],
            'null-output' => null,
        ] as $runId => $expected) {
            $client->request('POST', '/_gauntlet/v1/runs/' . $runId . '/cancel');
            self::assertResponseStatusCodeSame(202, $runId);
            $run = $this->responseJson($client->getResponse());
            self::assertArrayHasKey('output', $run, $runId);
            self::assertSame($expected, $run['output'], $runId);
        }

        $client->request('POST', '/_gauntlet/v1/runs/fractional-progress/cancel');
        self::assertResponseStatusCodeSame(202);
        $fractional = $this->responseJson($client->getResponse())['progress'];
        self::assertSame(0.25, $fractional['current']);
        self::assertSame(1.5, $fractional['total']);

        $client->request('POST', '/_gauntlet/v1/runs/no-output/cancel');
        self::assertResponseStatusCodeSame(202);
        $succeeded = $this->responseJson($client->getResponse());
        self::assertSame('succeeded', $succeeded['state']);
        self::assertArrayNotHasKey('output', $succeeded);

        $client->request('GET', '/_gauntlet/v1/runs/no-output/events');
        self::assertResponseIsSuccessful();
        $eventStream = $client->getInternalResponse()->getContent();
        self::assertStringContainsString("id: event-no-output\n", $eventStream);
        self::assertStringContainsString('"state":"succeeded"', $eventStream);
        self::assertStringNotContainsString('"output"', $eventStream);

        $client->request('POST', '/_gauntlet/v1/runs/sensitive-problem/cancel');
        self::assertResponseStatusCodeSame(202);
        $body = (string) $client->getResponse()->getContent();
        self::assertStringNotContainsString('731904', $body);
        $problem = $this->responseJson($client->getResponse())['problem'];
        self::assertSame([
            'type' => 'urn:gauntlet:problem:handler-failed',
            'title' => 'Operation failed',
            'status' => 500,
        ], array_intersect_key($problem, array_flip(['type', 'title', 'status'])));
        self::assertArrayNotHasKey('correlationId', $problem);

        $first = $body;
        $client->request('POST', '/_gauntlet/v1/runs/sensitive-problem/cancel');
        self::assertResponseStatusCodeSame(202);
        self::assertSame($first, (string) $client->getResponse()->getContent());
    }

    public function testRunEventsArePulledOneAtATimeAndReleaseTheIterator(): void
    {
        $kernel = self::bootKernel(['environment' => 'capabilities']);
        $response = $kernel->handle(Request::create('/_gauntlet/v1/runs/run-1/events'));

        self::assertInstanceOf(StreamedResponse::class, $response);
        $endpoint = self::getContainer()->get(FixtureEventsEndpoint::class);
        self::assertSame(0, $endpoint->yielded);
        self::assertFalse($endpoint->closed);

        ob_start();
        try {
            $response->sendContent();
            $body = ob_get_contents();
        } finally {
            ob_end_clean();
        }
        self::assertIsString($body);
        self::assertStringContainsString("id: event-1\n", $body);
        self::assertStringContainsString("id: event-2\n", $body);
        self::assertSame(2, $endpoint->yielded);
        self::assertTrue($endpoint->closed);
    }

    public function testLateRunEventIteratorFailureClosesWithoutLeakingItsException(): void
    {
        $kernel = self::bootKernel(['environment' => 'hostile_capabilities']);
        $response = $kernel->handle(Request::create('/_gauntlet/v1/runs/late-throw/events'));

        self::assertInstanceOf(StreamedResponse::class, $response);
        ob_start();
        try {
            $response->sendContent();
            $body = ob_get_contents();
        } finally {
            ob_end_clean();
        }
        self::assertIsString($body);
        self::assertStringContainsString("id: event-first\n", $body);
        self::assertStringNotContainsString('731904', $body);
        self::assertStringNotContainsString('RuntimeException', $body);
    }

    public function testRegressingRunEventStreamEmitsOnlyTheLastValidSnapshotAndCloses(): void
    {
        $kernel = self::bootKernel(['environment' => 'hostile_capabilities']);
        $response = $kernel->handle(Request::create('/_gauntlet/v1/runs/regressing-events/events'));

        self::assertInstanceOf(StreamedResponse::class, $response);
        $body = $this->streamContent($response);
        self::assertStringContainsString("id: event-2\n", $body);
        self::assertStringNotContainsString("id: event-1\n", $body);
        $endpoint = self::getContainer()->get(\EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\HostileEventsEndpoint::class);
        self::assertSame(2, $endpoint->yielded);
        self::assertTrue($endpoint->closed);
    }

    public function testIdenticalFailedRunReplayRemainsDeterministic(): void
    {
        $kernel = self::bootKernel(['environment' => 'hostile_capabilities']);
        $response = $kernel->handle(Request::create('/_gauntlet/v1/runs/replayed-failed-events/events'));

        self::assertInstanceOf(StreamedResponse::class, $response);
        $body = $this->streamContent($response);
        self::assertStringContainsString("id: event-replay-a\n", $body);
        self::assertStringContainsString("id: event-replay-b\n", $body);
        self::assertStringNotContainsString('correlationId', $body);
        self::assertStringNotContainsString('731904', $body);
    }

    public function testDisconnectedRunEventClientStopsPullingAndReleasesTheIterator(): void
    {
        $kernel = self::bootKernel(['environment' => 'disconnecting_events']);
        $response = $kernel->handle(Request::create('/_gauntlet/v1/runs/run-1/events'));

        self::assertInstanceOf(StreamedResponse::class, $response);
        ob_start();
        try {
            $response->sendContent();
            $body = ob_get_contents();
        } finally {
            ob_end_clean();
        }
        self::assertIsString($body);
        self::assertStringContainsString("id: event-1\n", $body);
        self::assertStringNotContainsString("id: event-2\n", $body);
        $endpoint = self::getContainer()->get(FixtureEventsEndpoint::class);
        self::assertSame(1, $endpoint->yielded);
        self::assertTrue($endpoint->closed);
        $connection = self::getContainer()->get(DisconnectingStreamConnection::class);
        self::assertSame(3, $connection->checks);
        self::assertSame(1, $connection->flushes);
    }

    public function testAlreadyDisconnectedRunEventClientDoesNotStartTheProvider(): void
    {
        $kernel = self::bootKernel(['environment' => 'disconnecting_events']);
        $response = $kernel->handle(Request::create('/_gauntlet/v1/runs/run-1/events'));

        self::assertInstanceOf(StreamedResponse::class, $response);
        $connection = self::getContainer()->get(DisconnectingStreamConnection::class);
        $connection->disconnectAfterChecks = 0;
        self::assertSame('', $this->streamContent($response));
        $endpoint = self::getContainer()->get(FixtureEventsEndpoint::class);
        self::assertSame(0, $endpoint->yielded);
        self::assertFalse($endpoint->closed);
        self::assertSame(1, $connection->checks);
        self::assertSame(0, $connection->flushes);
    }

    private function streamContent(StreamedResponse $response): string
    {
        ob_start();
        try {
            $response->sendContent();
            $body = ob_get_contents();
        } finally {
            ob_end_clean();
        }
        self::assertIsString($body);

        return $body;
    }

    private function assertSafeCapabilityFailure(\Symfony\Component\HttpFoundation\Response $response): void
    {
        self::assertSame(500, $response->getStatusCode());
        self::assertSame('application/problem+json', $response->headers->get('Content-Type'));
        $body = (string) $response->getContent();
        $problem = json_decode($body, true, flags: JSON_THROW_ON_ERROR);
        self::assertSame('urn:gauntlet:problem:adapter-internal-error', $problem['type']);
        self::assertSame(500, $problem['status']);
        self::assertMatchesRegularExpression('/^tc-[a-f0-9]{24}$/D', $problem['correlationId']);
        self::assertStringNotContainsString('731904', $body);
        self::assertStringNotContainsString('RuntimeException', $body);
    }
}
