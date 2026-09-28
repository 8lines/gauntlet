<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Integration;

use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\EchoOperation;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\FileOperation;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\HostileDataSource;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\InvalidSemanticsOperation;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\MissingCapabilityOperation;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\MissingDataSourceOperation;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\MissingFeatureOperation;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\MissingProfileOperation;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\RestrictedDataSource;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\UsersDataSource;

final class AdapterHttpTest extends BundleWebTestCase
{
    private const UUID = '11111111-1111-4111-8111-111111111111';

    public function testHealthManifestAndDefinitionUseCanonicalProtocolDocumentsAndEtags(): void
    {
        $client = self::createClient();
        $client->request('GET', '/_gauntlet/v1/health');
        self::assertResponseIsSuccessful();
        self::assertResponseHeaderSame('Content-Type', 'application/json');
        self::assertSame(['status' => 'ok', 'protocolVersion' => '1.0'], $this->responseJson($client->getResponse()));

        $client->request('GET', '/_gauntlet/v1/manifest');
        self::assertResponseIsSuccessful();
        $manifest = $this->responseJson($client->getResponse());
        self::assertSame(
            ['name' => 'fixture-test', 'kind' => 'test'],
            $manifest['application']['environment'],
        );
        self::assertSame(['tc-rich-forms@1', 'tc-schema-core@1'], $manifest['profiles']);
        self::assertSame([], $manifest['capabilities']);
        self::assertContains('fixture.users', array_column($manifest['dataSources'], 'id'));
        self::assertContains('invalid_operation_definition', array_column($manifest['diagnostics'], 'code'));
        self::assertStringNotContainsString('731904', (string) $client->getResponse()->getContent());
        self::assertStringNotContainsString('RuntimeException', (string) $client->getResponse()->getContent());
        $manifestEtag = $client->getResponse()->headers->get('ETag');
        self::assertSame('"' . $manifest['manifestRevision'] . '"', $manifestEtag);

        $client->request('GET', '/_gauntlet/v1/manifest', server: ['HTTP_IF_NONE_MATCH' => $manifestEtag]);
        self::assertResponseStatusCodeSame(304);
        self::assertSame('', $client->getResponse()->getContent());
        self::assertFalse($client->getResponse()->headers->has('Content-Type'));
        self::assertSame($manifestEtag, $client->getResponse()->headers->get('ETag'));

        $client->request('GET', '/_gauntlet/v1/operations/fixture.echo');
        self::assertResponseIsSuccessful();
        $body = (string) $client->getResponse()->getContent();
        $definition = $this->responseJson($client->getResponse());
        self::assertSame(['requestId'], $definition['contextSchema']['required']);
        self::assertSame('tc-rich-forms@1', $definition['uiSchema']['profile']);
        self::assertSame('/applicationId', $definition['dataSources'][0]['inputPointer']);
        self::assertEquals(new \stdClass(), (object) $definition['presets'][0]['input']);
        self::assertStringNotContainsString('EightLines\\', $body);
        self::assertStringNotContainsString('inputClass', $body);
        self::assertStringNotContainsString('invocation', $body);
        self::assertStringNotContainsString('definitionUrl', $body);
        $definitionEtag = $client->getResponse()->headers->get('ETag');
        self::assertSame('"' . $definition['revision'] . '"', $definitionEtag);

        $client->request(
            'GET',
            '/_gauntlet/v1/operations/fixture.echo',
            server: ['HTTP_IF_NONE_MATCH' => $definitionEtag],
        );
        self::assertResponseStatusCodeSame(304);
        self::assertSame('', $client->getResponse()->getContent());
    }

    public function testRunValidationReturnsPointersAndValidRunCanBePolledAndReplayed(): void
    {
        $client = self::createClient();
        $client->disableReboot();
        $revision = $this->operationRevision($client);

        $response = $this->postJson($client, '/_gauntlet/v1/operations/fixture.echo/runs', [
            'operationRevision' => $revision,
            'input' => ['applicationId' => 'not-a-uuid'],
            'context' => ['requestId' => 'fixture-invalid'],
        ]);
        self::assertSame(422, $response->getStatusCode());
        self::assertSame('application/problem+json', $response->headers->get('Content-Type'));
        self::assertSame('/applicationId', $this->responseJson($response)['errors'][0]['instancePath']);

        $request = [
            'operationRevision' => $revision,
            'input' => ['applicationId' => self::UUID],
            'context' => ['requestId' => 'fixture-create'],
            'idempotencyKey' => 'fixture-replay-key',
            'extensions' => ['urn:fixture:create' => ['opaque' => true]],
        ];
        $created = $this->postJson($client, '/_gauntlet/v1/operations/fixture.echo/runs', $request);
        self::assertSame(201, $created->getStatusCode());
        $run = $this->responseJson($created);
        self::assertSame('succeeded', $run['state']);
        self::assertSame('key-value', $run['artifacts'][0]['kind']);

        $client->request('GET', '/_gauntlet/v1/runs/' . $run['id']);
        self::assertResponseIsSuccessful();
        self::assertSame($run, $this->responseJson($client->getResponse()));

        $replay = $this->postJson($client, '/_gauntlet/v1/operations/fixture.echo/runs', $request);
        self::assertSame(201, $replay->getStatusCode());
        self::assertSame($run, $this->responseJson($replay));
        self::assertSame(1, self::getContainer()->get(EchoOperation::class)->executions);
        self::assertNull(self::getContainer()->get(EchoOperation::class)->retainedContext?->invocationContext());
    }

    public function testConfirmationAcknowledgementIsRequiredAndBoundBeforeRunAdmission(): void
    {
        $client = self::createClient(['environment' => 'capabilities']);
        $client->disableReboot();
        $revision = $this->operationRevision($client, 'fixture.file');
        $input = ['attachment' => ['uploadId' => 'not-inspected-before-confirmation']];

        $cases = [
            'missing' => [null, '/confirmation'],
            'operation ID mismatch' => [[
                'operationId' => 'fixture.echo',
                'operationRevision' => $revision,
                'impact' => 'write',
            ], '/confirmation/operationId'],
            'operation revision mismatch' => [[
                'operationId' => 'fixture.file',
                'operationRevision' => 'sha256:' . str_repeat('0', 64),
                'impact' => 'write',
            ], '/confirmation/operationRevision'],
            'impact mismatch' => [[
                'operationId' => 'fixture.file',
                'operationRevision' => $revision,
                'impact' => 'read',
            ], '/confirmation/impact'],
        ];

        foreach ($cases as $label => [$confirmation, $expectedPath]) {
            $request = [
                'operationRevision' => $revision,
                'input' => $input,
            ];
            if ($confirmation !== null) {
                $request['confirmation'] = $confirmation;
            }

            $response = $this->postJson(
                $client,
                '/_gauntlet/v1/operations/fixture.file/runs',
                $request,
            );

            self::assertSame(422, $response->getStatusCode(), $label);
            self::assertSame(
                $expectedPath,
                $this->responseJson($response)['errors'][0]['instancePath'],
                $label,
            );
            self::assertSame(0, self::getContainer()->get(FileOperation::class)->executions, $label);
        }

        $dryRun = $this->postJson($client, '/_gauntlet/v1/operations/fixture.file/runs', [
            'operationRevision' => $revision,
            'input' => $input,
            'dryRun' => true,
        ]);
        self::assertSame(422, $dryRun->getStatusCode());
        self::assertSame('/confirmation', $this->responseJson($dryRun)['errors'][0]['instancePath']);
        self::assertSame(0, self::getContainer()->get(FileOperation::class)->executions);
    }

    public function testConfirmationAcknowledgementEnvelopeIsClosedAndPointerExact(): void
    {
        $client = self::createClient(['environment' => 'capabilities']);
        $client->disableReboot();
        $revision = $this->operationRevision($client, 'fixture.file');
        $base = [
            'operationId' => 'fixture.file',
            'operationRevision' => $revision,
            'impact' => 'write',
        ];

        $cases = [
            'scalar object' => [true, '/confirmation'],
            'missing operation ID' => [[
                'operationRevision' => $revision,
                'impact' => 'write',
            ], '/confirmation/operationId'],
            'invalid operation ID' => [[...$base, 'operationId' => 'unsafe id'], '/confirmation/operationId'],
            'missing revision' => [[
                'operationId' => 'fixture.file',
                'impact' => 'write',
            ], '/confirmation/operationRevision'],
            'invalid revision' => [[...$base, 'operationRevision' => 'not-a-revision'], '/confirmation/operationRevision'],
            'missing impact' => [[
                'operationId' => 'fixture.file',
                'operationRevision' => $revision,
            ], '/confirmation/impact'],
            'invalid impact' => [[...$base, 'impact' => 'dangerous'], '/confirmation/impact'],
            'extra member' => [[...$base, 'unsafe' => true], '/confirmation/unsafe'],
            'non-object extensions' => [[...$base, 'extensions' => ['list-item']], '/confirmation/extensions'],
            'invalid extension name' => [[
                ...$base,
                'extensions' => ['not-a-urn' => true],
            ], '/confirmation/extensions/not-a-urn'],
        ];

        foreach ($cases as $label => [$confirmation, $expectedPath]) {
            $response = $this->postJson($client, '/_gauntlet/v1/operations/fixture.file/runs', [
                'operationRevision' => $revision,
                'input' => ['attachment' => ['uploadId' => 'never-inspected']],
                'confirmation' => $confirmation,
            ]);

            self::assertSame(422, $response->getStatusCode(), $label);
            self::assertSame(
                $expectedPath,
                $this->responseJson($response)['errors'][0]['instancePath'],
                $label,
            );
            self::assertSame(0, self::getContainer()->get(FileOperation::class)->executions, $label);
        }
    }

    public function testRunOutputPreservesEveryJsonRootShapeAndNullPresence(): void
    {
        $client = self::createClient();
        $revision = $this->operationRevision($client, 'fixture.json-value');

        foreach ([
            'object' => ['answer' => 42],
            'list' => [1, 'two'],
            'null' => null,
            'boolean' => true,
            'string' => 'done',
            'number' => 2.5,
            'absent' => null,
        ] as $mode => $expected) {
            $response = $this->postJson(
                $client,
                '/_gauntlet/v1/operations/fixture.json-value/runs',
                [
                    'operationRevision' => $revision,
                    'input' => ['mode' => $mode],
                ],
            );

            self::assertSame(201, $response->getStatusCode(), $mode);
            $run = $this->responseJson($response);
            self::assertSame('succeeded', $run['state'], $mode);
            if ($mode === 'absent') {
                self::assertArrayNotHasKey('output', $run, $mode);
            } else {
                self::assertArrayHasKey('output', $run, $mode);
                self::assertSame($expected, $run['output'], $mode);
            }
        }
    }

    public function testStaleAndUnavailableOperationsShortCircuitBeforeExecution(): void
    {
        $client = self::createClient();
        $revision = $this->operationRevision($client);
        $stale = substr($revision, 0, -1) . ($revision[-1] === '0' ? '1' : '0');
        $client->request('GET', '/_gauntlet/v1/manifest');
        $manifest = $this->responseJson($client->getResponse());
        $unavailableProblem = [
            'type' => 'urn:gauntlet:problem:adapter-unavailable',
            'title' => 'Operation unavailable',
            'status' => 503,
            'detail' => 'The operation requirements are not available in this adapter.',
        ];

        $response = $this->postJson($client, '/_gauntlet/v1/operations/fixture.echo/runs', [
            'operationRevision' => $stale,
            'input' => ['applicationId' => self::UUID],
        ]);
        self::assertSame(409, $response->getStatusCode());
        self::assertSame('urn:gauntlet:problem:stale-operation-revision', $this->responseJson($response)['type']);

        foreach ([
            'fixture.missing-profile' => MissingProfileOperation::class,
            'fixture.missing-capability' => MissingCapabilityOperation::class,
            'fixture.file' => FileOperation::class,
        ] as $operationId => $service) {
            $summary = array_values(array_filter(
                $manifest['operations'],
                static fn (array $operation): bool => $operation['id'] === $operationId,
            ))[0];
            self::assertSame('unavailable', $summary['availability']['state']);
            self::assertSame($unavailableProblem, $summary['availability']['problem']);
            self::assertArrayNotHasKey('capability', $summary['availability']['problem']);

            $client->request(
                'POST',
                '/_gauntlet/v1/operations/' . $operationId . '/runs',
                server: ['CONTENT_TYPE' => 'application/json'],
                content: '{not-json',
            );
            self::assertResponseStatusCodeSame(503);
            self::assertSame($unavailableProblem, $this->responseJson($client->getResponse()));
            self::assertSame(0, self::getContainer()->get($service)->executions);
        }
    }

    public function testOperationsWithBrokenBindingsAreOmittedFromEveryPublicGate(): void
    {
        $client = self::createClient();
        $client->request('GET', '/_gauntlet/v1/manifest');
        $manifest = $this->responseJson($client->getResponse());
        $operationIds = array_column($manifest['operations'], 'id');
        self::assertNotContains('fixture.missing-feature', $operationIds);
        self::assertNotContains('fixture.missing-data-source', $operationIds);
        self::assertNotContains('fixture.invalid-semantics', $operationIds);
        self::assertNotContains('fixture.orphan', array_column($manifest['features'], 'id'));
        self::assertContains('invalid_feature_binding', array_column($manifest['diagnostics'], 'code'));
        self::assertGreaterThanOrEqual(
            2,
            count(array_filter(
                array_column($manifest['diagnostics'], 'code'),
                static fn (string $code): bool => $code === 'invalid_operation_binding',
            )),
        );

        foreach ([
            'fixture.missing-feature' => MissingFeatureOperation::class,
            'fixture.missing-data-source' => MissingDataSourceOperation::class,
            'fixture.invalid-semantics' => InvalidSemanticsOperation::class,
        ] as $operationId => $service) {
            $client->request('GET', '/_gauntlet/v1/operations/' . $operationId);
            self::assertResponseStatusCodeSame(404);

            $client->request(
                'POST',
                '/_gauntlet/v1/operations/' . $operationId . '/runs',
                server: ['CONTENT_TYPE' => 'application/json'],
                content: '{not-json',
            );
            self::assertResponseStatusCodeSame(404);
            self::assertSame(0, self::getContainer()->get($service)->executions);
        }
    }

    public function testUnhandledHandlerFailureBecomesSafeFailedRun(): void
    {
        $client = self::createClient();
        $client->disableReboot();
        $revision = $this->operationRevision($client, 'fixture.failing');
        $response = $this->postJson($client, '/_gauntlet/v1/operations/fixture.failing/runs', [
            'operationRevision' => $revision,
            'input' => ['applicationId' => self::UUID],
            'context' => ['requestId' => 'fixture-failure'],
        ]);

        self::assertSame(201, $response->getStatusCode());
        $run = $this->responseJson($response);
        self::assertSame('failed', $run['state']);
        self::assertSame('urn:gauntlet:problem:handler-failed', $run['problem']['type']);
        self::assertSame('Operation failed', $run['problem']['title']);
        self::assertSame(500, $run['problem']['status']);
        self::assertArrayNotHasKey('correlationId', $run['problem']);
        self::assertStringNotContainsString('fixture exception detail', (string) $response->getContent());
        self::assertStringNotContainsString('RuntimeException', (string) $response->getContent());

        $client->request('GET', '/_gauntlet/v1/runs/' . $run['id']);
        self::assertResponseIsSuccessful();
        self::assertSame($run, $this->responseJson($client->getResponse()));
    }

    public function testQueryAndResolvePassCompleteDependenciesAndContext(): void
    {
        $client = self::createClient();
        $query = $this->postJson($client, '/_gauntlet/v1/data-sources/fixture.users/query', [
            'search' => 'Brown',
            'dependencies' => ['/agencyId' => 'agency-1'],
            'context' => ['requestId' => 'query-request-1'],
            'extensions' => ['urn:fixture:query' => ['source' => 'dashboard']],
        ]);
        self::assertSame(200, $query->getStatusCode());
        self::assertSame('Acme Insurance', $this->responseJson($query)['items'][0]['label']);
        self::assertSame(
            ['urn:fixture:query' => ['source' => 'dashboard']],
            $this->protocolArray(
                self::getContainer()->get(UsersDataSource::class)->lastQuery()?->extensions?->toProtocolArray(),
            ),
        );

        $resolve = $this->postJson($client, '/_gauntlet/v1/data-sources/fixture.users/resolve', [
            'values' => ['user-1', 'missing', ''],
            'dependencies' => ['/agencyId' => 'agency-1'],
            'context' => [
                'requestId' => 'resolve-request-1',
                'extensions' => ['urn:fixture:brandId' => 'brand-1'],
            ],
            'extensions' => ['urn:fixture:resolve' => true],
        ]);
        self::assertSame(200, $resolve->getStatusCode());
        self::assertSame(['user-1', 'missing', ''], array_column($this->responseJson($resolve)['results'], 'value'));
        self::assertSame(
            [
                'values' => ['user-1', 'missing', ''],
                'dependencies' => ['/agencyId' => 'agency-1'],
                'context' => [
                    'requestId' => 'resolve-request-1',
                    'extensions' => ['urn:fixture:brandId' => 'brand-1'],
                ],
                'extensions' => ['urn:fixture:resolve' => true],
            ],
            $this->protocolArray(
                self::getContainer()->get(UsersDataSource::class)->lastResolveRequest()?->toProtocolArray(),
            ),
        );

        $empty = $this->postJson($client, '/_gauntlet/v1/data-sources/fixture.users/resolve', [
            'values' => [],
            'dependencies' => ['/agencyId' => 'agency-1'],
            'context' => ['requestId' => 'resolve-empty'],
        ]);
        self::assertSame(['results' => []], $this->responseJson($empty));

        $invalid = $this->postJson($client, '/_gauntlet/v1/data-sources/fixture.users/query', [
            'dependencies' => ['/agencyId' => 'agency-1'],
            'context' => ['requestId' => 'query-invalid-extension'],
            'extensions' => ['not-a-urn' => true],
        ]);
        self::assertSame(422, $invalid->getStatusCode());
        self::assertSame(
            '/extensions/not-a-urn',
            $this->responseJson($invalid)['errors'][0]['instancePath'],
        );
    }

    public function testProtocolInvalidDataSourceCapabilitiesAreDiagnosedAndNeverRouted(): void
    {
        $client = self::createClient();
        $client->disableReboot();
        $client->request('GET', '/_gauntlet/v1/manifest');
        $manifest = $this->responseJson($client->getResponse());
        self::assertNotContains('fixture.restricted', array_column($manifest['dataSources'], 'id'));
        self::assertContains('invalid_data_source_definition', array_column($manifest['diagnostics'], 'code'));

        foreach (['query', 'resolve'] as $endpoint) {
            $request = $endpoint === 'query'
                ? ['dependencies' => new \stdClass()]
                : ['values' => ['value'], 'dependencies' => new \stdClass()];
            $response = $this->postJson(
                $client,
                '/_gauntlet/v1/data-sources/fixture.restricted/' . $endpoint,
                $request,
            );
            self::assertSame(404, $response->getStatusCode());
            self::assertSame('application/problem+json', $response->headers->get('Content-Type'));
            self::assertSame(
                'urn:gauntlet:problem:data-source-not-found',
                $this->responseJson($response)['type'],
            );
        }

        $source = self::getContainer()->get(RestrictedDataSource::class);
        self::assertSame(0, $source->queryInvocations);
        self::assertSame(0, $source->resolveInvocations);
    }

    public function testRequiredDataSourceContextCannotBeBypassedByOmission(): void
    {
        $client = self::createClient();
        $client->disableReboot();

        $query = $this->postJson($client, '/_gauntlet/v1/data-sources/fixture.users/query', [
            'dependencies' => ['/agencyId' => 'agency-1'],
        ]);
        self::assertSame(422, $query->getStatusCode());
        self::assertSame('/requestId', $this->responseJson($query)['errors'][0]['instancePath']);

        $resolve = $this->postJson($client, '/_gauntlet/v1/data-sources/fixture.users/resolve', [
            'values' => ['user-1'],
            'dependencies' => ['/agencyId' => 'agency-1'],
        ]);
        self::assertSame(422, $resolve->getStatusCode());
        self::assertSame('/requestId', $this->responseJson($resolve)['errors'][0]['instancePath']);

        $source = self::getContainer()->get(UsersDataSource::class);
        self::assertNull($source->lastQuery());
        self::assertNull($source->lastResolveRequest());
    }

    public function testInvalidDataSourcePagesFailClosedAtTheResponseBoundary(): void
    {
        $client = self::createClient();
        $client->disableReboot();

        foreach (['invalid-shape', 'invalid-scalar'] as $scenario) {
            $response = $this->postJson($client, '/_gauntlet/v1/data-sources/fixture.hostile/query', [
                'search' => $scenario,
                'dependencies' => new \stdClass(),
            ]);
            $this->assertSafeInternalDataSourceProblem($response);
        }

        self::assertSame(2, self::getContainer()->get(HostileDataSource::class)->queryInvocations);
    }

    public function testInvalidDataSourceResolveResponsesFailClosedAtTheResponseBoundary(): void
    {
        $client = self::createClient();
        $client->disableReboot();

        foreach (['semantic-mismatch', 'invalid-shape', 'invalid-scalar'] as $scenario) {
            $response = $this->postJson($client, '/_gauntlet/v1/data-sources/fixture.hostile/resolve', [
                'values' => [$scenario],
                'dependencies' => new \stdClass(),
            ]);
            $this->assertSafeInternalDataSourceProblem($response);
        }

        self::assertSame(3, self::getContainer()->get(HostileDataSource::class)->resolveInvocations);
    }

    public function testJsonRequestBoundaryUsesExactMediaSizeAndClosedEnvelopeProblems(): void
    {
        $client = self::createClient();
        foreach ([
            ['text/plain', '{}', [], 415, 'urn:gauntlet:problem:unsupported-media-type'],
            ['application/json', '{not-json', [], 400, 'urn:gauntlet:problem:invalid-json'],
            ['application/json', '[]', [], 422, 'urn:gauntlet:problem:validation-failed'],
            [
                'application/json',
                json_encode(['unknown' => true], JSON_THROW_ON_ERROR),
                [],
                422,
                'urn:gauntlet:problem:validation-failed',
            ],
            [
                'application/json',
                json_encode(['padding' => str_repeat('x', 5000)], JSON_THROW_ON_ERROR),
                [],
                413,
                'urn:gauntlet:problem:request-too-large',
            ],
            [
                'application/json',
                '{}',
                ['CONTENT_LENGTH' => '999999999999999999999999'],
                413,
                'urn:gauntlet:problem:request-too-large',
            ],
        ] as [$contentType, $body, $server, $status, $type]) {
            $client->request(
                'POST',
                '/_gauntlet/v1/data-sources/fixture.users/query',
                server: ['CONTENT_TYPE' => $contentType, ...$server],
                content: $body,
            );
            self::assertSame($status, $client->getResponse()->getStatusCode());
            $problem = $this->responseJson($client->getResponse());
            self::assertSame($status, $problem['status']);
            self::assertSame($type, $problem['type']);
            if (isset($problem['errors'][0])) {
                self::assertStringNotContainsString('true', $problem['errors'][0]['message']);
            }
        }

        $client->request(
            'POST',
            '/_gauntlet/v1/data-sources/fixture.users/query',
            server: ['CONTENT_TYPE' => 'application/json; charset=utf-8'],
            content: json_encode([
                'dependencies' => ['/agencyId' => 'agency-1'],
                'context' => ['requestId' => 'media-parameter'],
            ], JSON_THROW_ON_ERROR),
        );
        self::assertResponseIsSuccessful();
    }

    public function testUnknownResourcesAndUnsupportedCapabilitiesUseTypedProblems(): void
    {
        $client = self::createClient();
        foreach ([
            ['GET', '/_gauntlet/v1/operations/missing'],
            ['GET', '/_gauntlet/v1/runs/missing'],
            ['POST', '/_gauntlet/v1/data-sources/missing/query'],
        ] as [$method, $uri]) {
            $client->request($method, $uri, server: ['CONTENT_TYPE' => 'application/json'], content: '{}');
            self::assertResponseStatusCodeSame(404);
            self::assertResponseHeaderSame('Content-Type', 'application/problem+json');
        }

        foreach ([
            ['POST', '/_gauntlet/v1/runs/run-1/cancel', 'tc-run-cancellation@1'],
            ['GET', '/_gauntlet/v1/runs/run-1/events', 'tc-run-sse@1'],
            ['POST', '/_gauntlet/v1/uploads', 'tc-uploads@1'],
            ['POST', '/_gauntlet/v1/runs/run-1/artifacts/artifact-1/launch', 'tc-session-launch@1'],
        ] as [$method, $uri, $capability]) {
            $client->request($method, $uri, content: '{not-json');
            self::assertResponseStatusCodeSame(501);
            self::assertSame([
                'type' => 'urn:gauntlet:problem:unsupported-capability',
                'title' => 'Unsupported capability',
                'status' => 501,
                'detail' => 'The adapter does not advertise or implement this capability.',
                'capability' => $capability,
            ], $this->responseJson($client->getResponse()));
        }
    }

    /** @return array<string, mixed> */
    private function protocolArray(array|object|null $value): array
    {
        return json_decode(json_encode($value, JSON_THROW_ON_ERROR), true, flags: JSON_THROW_ON_ERROR);
    }

    private function assertSafeInternalDataSourceProblem(
        \Symfony\Component\HttpFoundation\Response $response,
    ): void {
        self::assertSame(500, $response->getStatusCode());
        self::assertSame('application/problem+json', $response->headers->get('Content-Type'));
        $problem = $this->responseJson($response);
        self::assertSame('urn:gauntlet:problem:adapter-internal-error', $problem['type']);
        self::assertSame('Adapter internal error', $problem['title']);
        self::assertSame(500, $problem['status']);
        self::assertMatchesRegularExpression('/^tc-[a-f0-9]{24}$/D', $problem['correlationId']);
        self::assertStringNotContainsString('not-a-data-source-item', (string) $response->getContent());
        self::assertStringNotContainsString('forbidden-cursor', (string) $response->getContent());
    }
}
