<?php

declare(strict_types=1);

namespace Gauntlet\SymfonyExample\Tests;

use PHPUnit\Framework\TestCase;
use Symfony\Component\HttpKernel\HttpKernelBrowser;
use Gauntlet\SymfonyExample\Kernel;
use Gauntlet\SymfonyExample\Gauntlet\FinalizeAgencyApplicationOperation;

final class AdapterConformanceTest extends TestCase
{
    private const SECRET_SENTINEL = '731904';

    private HttpKernelBrowser $client;

    private Kernel $kernel;

    private string $runStorePath;

    /** @var list<string> */
    private array $capturedResponses = [];

    protected function setUp(): void
    {
        $this->runStorePath = sys_get_temp_dir()
            . '/gauntlet-symfony-example/phpunit-'
            . bin2hex(random_bytes(12))
            . '.store';
        putenv('GAUNTLET_ENABLED=true');
        putenv('GAUNTLET_IDEMPOTENCY_SECRET=fixture-symfony-idempotency-secret-32-bytes');
        putenv('GAUNTLET_RUN_STORE_PATH=' . $this->runStorePath);
        $_SERVER['GAUNTLET_ENABLED'] = 'true';
        $_SERVER['GAUNTLET_IDEMPOTENCY_SECRET'] = 'fixture-symfony-idempotency-secret-32-bytes';
        $_SERVER['GAUNTLET_RUN_STORE_PATH'] = $this->runStorePath;
        $this->kernel = new Kernel('test', true);
        $this->client = new HttpKernelBrowser($this->kernel);
    }

    protected function tearDown(): void
    {
        foreach ($this->capturedResponses as $response) {
            self::assertStringNotContainsString(self::SECRET_SENTINEL, $response);
        }
        $this->kernel->shutdown();
        unset($_SERVER['GAUNTLET_ENABLED']);
        unset($_SERVER['GAUNTLET_IDEMPOTENCY_SECRET']);
        unset($_SERVER['GAUNTLET_RUN_STORE_PATH']);
        putenv('GAUNTLET_ENABLED');
        putenv('GAUNTLET_IDEMPOTENCY_SECRET');
        putenv('GAUNTLET_RUN_STORE_PATH');
        if (is_file($this->runStorePath)) {
            unlink($this->runStorePath);
        }
    }

    public function testAdapterRequiresAnExplicitDeploymentFlag(): void
    {
        unset($_SERVER['GAUNTLET_ENABLED']);
        putenv('GAUNTLET_ENABLED');
        $disabledKernel = new Kernel('prod', false);
        $disabled = new HttpKernelBrowser($disabledKernel);
        $disabled->request('GET', '/_gauntlet/v1/health');
        self::assertSame(503, $disabled->getResponse()->getStatusCode());
        self::assertSame(
            'urn:gauntlet:problem:adapter-disabled',
            json_decode(
                (string) $disabled->getResponse()->getContent(),
                true,
                flags: JSON_THROW_ON_ERROR,
            )['type'],
        );
        $disabledKernel->shutdown();

        putenv('GAUNTLET_ENABLED=true');
        $_SERVER['GAUNTLET_ENABLED'] = 'true';
        $enabledKernel = new Kernel('conformance', false);
        $enabled = new HttpKernelBrowser($enabledKernel);
        $enabled->request('GET', '/_gauntlet/v1/health');
        self::assertSame(200, $enabled->getResponse()->getStatusCode());
        self::assertSame(
            ['status' => 'ok', 'protocolVersion' => '1.0'],
            json_decode(
                (string) $enabled->getResponse()->getContent(),
                true,
                flags: JSON_THROW_ON_ERROR,
            ),
        );
        $enabledKernel->shutdown();
    }

    public function testReferenceAdapterPublishesAndExecutesSharedScenario(): void
    {
        $scenario = $this->scenario();
        $manifest = $this->getJson('/_gauntlet/v1/manifest');
        self::assertContains($scenario['operationId'], array_column($manifest['operations'], 'id'));
        self::assertSame(['tc-session-launch@1'], $manifest['capabilities']);
        self::assertSame(
            ['name' => 'symfony-example-test', 'kind' => 'test'],
            $manifest['application']['environment'],
        );

        $page = $this->postJson(
            '/_gauntlet/v1/data-sources/' . $scenario['dataSourceId'] . '/query',
            $scenario['dataSourceQuery'],
        );
        self::assertSame('Alice Brown', $page['items'][0]['label']);

        $definition = $this->getJson('/_gauntlet/v1/operations/' . $scenario['operationId']);
        $create = [
            'operationRevision' => $definition['revision'],
            'input' => $scenario['input'],
            'context' => [
                'requestId' => 'symfony-example-create-01',
                'target' => ['id' => 'conformance-target', 'environment' => 'test'],
            ],
            'idempotencyKey' => $scenario['idempotencyKey'],
            'confirmation' => $this->confirmation($definition),
        ];
        $run = $this->postJson('/_gauntlet/v1/operations/' . $scenario['operationId'] . '/runs', $create, 201);
        self::assertSame('succeeded', $run['state']);
        self::assertSame($run, $this->postJson(
            '/_gauntlet/v1/operations/' . $scenario['operationId'] . '/runs',
            $create,
            201,
        ));
        self::assertSame($run, $this->getJson('/_gauntlet/v1/runs/' . $run['id']));
        $operation = $this->kernel->getContainer()->get(FinalizeAgencyApplicationOperation::class);
        self::assertInstanceOf(FinalizeAgencyApplicationOperation::class, $operation);
        self::assertNull($operation->retainedContext?->invocationContext());

        $session = $this->postJson(
            '/_gauntlet/v1/runs/'
                . $run['id']
                . '/artifacts/'
                . $scenario['browserLaunch']['artifactId']
                . '/launch',
            null,
            201,
        );
        self::assertStringStartsWith($scenario['browserLaunch']['expectedPublicOrigin'], $session['url']);
        self::assertTrue($session['singleUse']);
    }

    public function testRunAndIdempotencyReservationSurviveAnIndependentKernel(): void
    {
        $scenario = $this->scenario();
        $definition = $this->getJson('/_gauntlet/v1/operations/' . $scenario['operationId']);
        $create = [
            'operationRevision' => $definition['revision'],
            'input' => $scenario['input'],
            'context' => ['requestId' => 'symfony-independent-kernel'],
            'idempotencyKey' => 'symfony-independent-kernel-key',
            'confirmation' => $this->confirmation($definition),
        ];
        $run = $this->postJson(
            '/_gauntlet/v1/operations/' . $scenario['operationId'] . '/runs',
            $create,
            201,
        );

        $this->kernel->shutdown();
        $this->kernel = new Kernel('test', true);
        $this->client = new HttpKernelBrowser($this->kernel);

        self::assertSame($run, $this->getJson('/_gauntlet/v1/runs/' . $run['id']));
        self::assertSame($run, $this->postJson(
            '/_gauntlet/v1/operations/' . $scenario['operationId'] . '/runs',
            $create,
            201,
        ));
    }

    public function testInvalidInputResolvePaginationAndUnsupportedCapabilities(): void
    {
        $scenario = $this->scenario();
        $definition = $this->getJson('/_gauntlet/v1/operations/' . $scenario['operationId']);
        $problem = $this->postJson('/_gauntlet/v1/operations/' . $scenario['operationId'] . '/runs', [
            'operationRevision' => $definition['revision'],
            'input' => $scenario['invalidInput'],
            'context' => ['requestId' => 'symfony-invalid'],
            'idempotencyKey' => 'invalid-example-run',
            'confirmation' => $this->confirmation($definition),
        ], 422);
        self::assertSame($scenario['expectedValidationPointer'], $problem['errors'][0]['instancePath']);

        $resolved = $this->postJson(
            '/_gauntlet/v1/data-sources/' . $scenario['dataSourceId'] . '/resolve',
            $scenario['dataSourceResolveRequest'],
        );
        self::assertSame($scenario['dataSourceResolveRequest']['values'], array_column($resolved['results'], 'value'));

        $first = $this->postJson('/_gauntlet/v1/data-sources/' . $scenario['dataSourceId'] . '/query', [
            'limit' => 1,
            'dependencies' => ['/workflowState' => 'pending'],
            'context' => $scenario['dataSourceQuery']['context'],
        ]);
        self::assertArrayHasKey('nextCursor', $first);
        $second = $this->postJson('/_gauntlet/v1/data-sources/' . $scenario['dataSourceId'] . '/query', [
            'cursor' => $first['nextCursor'],
            'limit' => 1,
            'dependencies' => ['/workflowState' => 'pending'],
            'context' => $scenario['dataSourceQuery']['context'],
        ]);
        self::assertNotSame($first['items'][0]['value'], $second['items'][0]['value']);

        foreach ([
            ['POST', '/_gauntlet/v1/runs/run-1/cancel', 'tc-run-cancellation@1'],
            ['GET', '/_gauntlet/v1/runs/run-1/events', 'tc-run-sse@1'],
            ['POST', '/_gauntlet/v1/uploads', 'tc-uploads@1'],
        ] as [$method, $path, $capability]) {
            $this->client->request($method, $path);
            self::assertSame(501, $this->client->getResponse()->getStatusCode());
            self::assertSame($capability, $this->responseJson()['capability']);
        }
    }

    public function testDisabledPrefixPrecedesMalformedTargetAndBody(): void
    {
        $disabledKernel = new Kernel('disabled', true);
        $client = new HttpKernelBrowser($disabledKernel);
        $client->request(
            'POST',
            '/_gauntlet/v1/operations/unsafe%21id/runs?forbidden=1',
            server: ['CONTENT_TYPE' => 'application/json'],
            content: '{not-json',
        );

        self::assertSame(503, $client->getResponse()->getStatusCode());
        self::assertSame(
            'urn:gauntlet:problem:adapter-disabled',
            json_decode((string) $client->getResponse()->getContent(), true, flags: JSON_THROW_ON_ERROR)['type'],
        );
        $disabledKernel->shutdown();
    }

    public function testUnhandledApplicationFailureIsASecretFreeFailedRun(): void
    {
        $definition = $this->getJson('/_gauntlet/v1/operations/agency-applications.fail');
        $run = $this->postJson('/_gauntlet/v1/operations/agency-applications.fail/runs', [
            'operationRevision' => $definition['revision'],
            'input' => [
                'applicationId' => '11111111-1111-4111-8111-111111111111',
                'confirmationCode' => self::SECRET_SENTINEL,
            ],
            'context' => ['requestId' => 'symfony-example-failure'],
            'idempotencyKey' => 'symfony-example-failure-key',
            'confirmation' => $this->confirmation($definition),
        ], 201);

        self::assertSame('failed', $run['state']);
        self::assertSame('urn:gauntlet:problem:handler-failed', $run['problem']['type']);
        self::assertSame('Operation failed', $run['problem']['title']);
        self::assertArrayNotHasKey('correlationId', $run['problem']);
        self::assertArrayNotHasKey('detail', $run['problem']);
    }

    /** @return array<string, mixed> */
    private function scenario(): array
    {
        return json_decode(
            (string) file_get_contents(dirname(__DIR__, 3) . '/conformance/scenarios/adapter-v1.json'),
            true,
            flags: JSON_THROW_ON_ERROR,
        );
    }

    /**
     * @param array<string, mixed> $definition
     * @return array{operationId: string, operationRevision: string, impact: string}
     */
    private function confirmation(array $definition): array
    {
        return [
            'operationId' => $definition['id'],
            'operationRevision' => $definition['revision'],
            'impact' => $definition['execution']['impact'],
        ];
    }

    /** @return array<string, mixed> */
    private function getJson(string $path, int $expectedStatus = 200): array
    {
        $this->client->request('GET', $path);
        self::assertSame($expectedStatus, $this->client->getResponse()->getStatusCode());

        return $this->responseJson();
    }

    /** @param array<string, mixed>|null $body @return array<string, mixed> */
    private function postJson(string $path, ?array $body, int $expectedStatus = 200): array
    {
        $this->client->request(
            'POST',
            $path,
            server: $body === null ? [] : ['CONTENT_TYPE' => 'application/json'],
            content: $body === null ? null : json_encode($body, JSON_THROW_ON_ERROR),
        );
        self::assertSame($expectedStatus, $this->client->getResponse()->getStatusCode());

        return $this->responseJson();
    }

    /** @return array<string, mixed> */
    private function responseJson(): array
    {
        $content = (string) $this->client->getResponse()->getContent();
        $this->capturedResponses[] = $content;

        return json_decode($content, true, flags: JSON_THROW_ON_ERROR);
    }
}
