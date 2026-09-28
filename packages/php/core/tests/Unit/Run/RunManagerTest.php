<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Run;

use EightLines\Gauntlet\Core\Contract\InputMapper;
use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Contract\RunStore;
use EightLines\Gauntlet\Core\DataSource\DataSourceResolveRequest;
use EightLines\Gauntlet\Core\DataSource\DataSourceQuery;
use EightLines\Gauntlet\Core\Definition\ExecutionPolicy;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Definition\OperationOutput;
use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Registry\OperationRegistry;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\Core\Run\CreateRunRequest;
use EightLines\Gauntlet\Core\Run\InMemoryRunStore;
use EightLines\Gauntlet\Core\Run\InvocationContext;
use EightLines\Gauntlet\Core\Run\RunManager;
use EightLines\Gauntlet\Core\Run\Run;
use EightLines\Gauntlet\Core\Run\RunStatus;
use EightLines\Gauntlet\Core\Run\RunStoreCreateResult;
use EightLines\Gauntlet\Core\Schema\OpisSchemaValidator;
use EightLines\Gauntlet\Core\Schema\TcSchemaCore;
use PHPUnit\Framework\TestCase;

final class RunManagerTest extends TestCase
{
    public function testResolveAcceptsEmptyAndEmptyStringValues(): void
    {
        self::assertSame([], (new DataSourceResolveRequest([], JsonOwnership::object([])))->toProtocolArray()['values']);
        self::assertSame([''], (new DataSourceResolveRequest([''], JsonOwnership::object([])))->toProtocolArray()['values']);
    }

    public function testCreateQueryAndResolveEnvelopesOwnNamespacedExtensionsWithoutShapeLoss(): void
    {
        $extensions = new ProtocolExtensions(JsonOwnership::object([
            'urn:test:extension' => (object) [
                '__proto__' => (object) ['enabled' => true],
            ],
        ]));
        $revision = 'sha256:' . str_repeat('a', 64);
        $create = new CreateRunRequest($revision, JsonOwnership::object([]), extensions: $extensions);
        $query = new DataSourceQuery(null, null, null, JsonOwnership::object([]), extensions: $extensions);
        $resolve = new DataSourceResolveRequest([], JsonOwnership::object([]), extensions: $extensions);

        foreach ([$create->toProtocolArray(), $query->toProtocolArray(), $resolve->toProtocolArray()] as $wire) {
            self::assertEquals(
                (object) ['enabled' => true],
                $wire['extensions']->{'urn:test:extension'}->{'__proto__'},
            );
        }
        self::assertSame('{}', json_encode((new ProtocolExtensions(JsonOwnership::object([])))->toProtocolArray()));

        foreach (['', '__proto__', 'urn:'] as $invalidKey) {
            try {
                new ProtocolExtensions(JsonOwnership::object([$invalidKey => true]));
                self::fail('Expected invalid extension key to be rejected.');
            } catch (\InvalidArgumentException) {
                self::addToAssertionCount(1);
            }
        }
    }

    public function testStaleRevisionDoesNotPersistAndSameKeyReplaysTerminalRun(): void
    {
        $handler = new RunHandler();
        $store = new InMemoryRunStore();
        $manager = self::manager($handler, $store);
        $stale = $manager->create('test.echo', new CreateRunRequest(
            'sha256:' . str_repeat('0', 64),
            JsonOwnership::object(['message' => 'hello']),
        ));
        self::assertSame(409, $stale->problem?->status);
        self::assertSame([], $store->all());

        $request = self::request($handler, 'same');
        $first = $manager->create('test.echo', $request);
        $second = $manager->create('test.echo', $request);
        self::assertSame('succeeded', $first->run?->state->value);
        self::assertSame($first->run?->id, $second->run?->id);
        self::assertSame(1, $handler->executions);
        self::assertFalse($store->containsText('same'));
    }

    public function testInputIsSchemaValidatedThenMappedToTheDeclaredDto(): void
    {
        $handler = new RunHandler(inputClass: RunInput::class);
        $store = new InMemoryRunStore();
        $mapper = new RunInputMapper();
        $manager = self::manager($handler, $store, $mapper);

        $invalid = $manager->create('test.echo', new CreateRunRequest(
            $handler->definition()->revision(),
            JsonOwnership::object([]),
            new InvocationContext('request-invalid'),
        ));
        self::assertSame(422, $invalid->problem?->status);
        self::assertSame([], $store->all());
        self::assertSame(0, $mapper->calls);

        $valid = $manager->create('test.echo', self::request($handler, 'mapped', 'request-mapped'));
        self::assertTrue($valid->isSuccess());
        self::assertSame(1, $mapper->calls);
        self::assertInstanceOf(RunInput::class, $handler->receivedInput);
    }

    public function testHandlerFailureIsSanitizedCorrelatedAndClosesRetainedContext(): void
    {
        $handler = new RunHandler(fail: true);
        $store = new InMemoryRunStore();
        $result = self::manager($handler, $store)->create(
            'test.echo',
            self::request($handler, 'failure', 'request-correlation'),
        );

        self::assertSame('failed', $result->run?->state->value);
        self::assertSame('request-correlation', $result->run?->problem?->correlationId);
        self::assertNull($handler->retainedContext?->invocationContext());
        self::assertFalse($handler->retainedContext?->isDryRun());
        self::assertFalse($store->containsText('context-secret'));
        self::assertStringNotContainsString('private handler detail', json_encode($result->run?->toProtocolArray(), JSON_THROW_ON_ERROR));
    }

    public function testShortFingerprintSecretsAndHostileStoreReadsFailClosed(): void
    {
        $handler = new RunHandler();
        $this->expectException(\InvalidArgumentException::class);
        new RunManager(
            new OperationRegistry([$handler]),
            new InMemoryRunStore(),
            new OpisSchemaValidator(),
            'too-short',
        );
    }

    public function testHostileDuplicateWinnerAndMismatchedGetAreRejected(): void
    {
        $handler = new RunHandler();
        $wrong = new Run(
            'wrong-run',
            'other.operation',
            'sha256:' . str_repeat('a', 64),
            0,
            RunStatus::QUEUED,
            '2026-08-30T10:00:00Z',
            '2026-08-30T10:00:00Z',
        );
        $store = new HostileRunStore($wrong);
        $manager = new RunManager(
            new OperationRegistry([$handler]),
            $store,
            new OpisSchemaValidator(),
            str_repeat('s', 32),
        );

        self::assertNull($manager->get('requested-run'));
        $result = $manager->create('test.echo', self::request($handler, 'hostile'));
        self::assertFalse($result->isSuccess());
        self::assertSame(500, $result->problem?->status);
        self::assertSame(0, $handler->executions);
    }

    private static function manager(
        RunHandler $handler,
        InMemoryRunStore $store,
        ?InputMapper $mapper = null,
    ): RunManager {
        return new RunManager(
            new OperationRegistry([$handler]),
            $store,
            new OpisSchemaValidator(),
            str_repeat('s', 32),
            $mapper,
        );
    }

    private static function request(
        RunHandler $handler,
        ?string $key,
        string $requestId = 'request-1',
    ): CreateRunRequest {
        return new CreateRunRequest(
            $handler->definition()->revision(),
            JsonOwnership::object(['message' => 'hello']),
            new InvocationContext(
                requestId: $requestId,
                extensions: JsonOwnership::object(['urn:test:context' => 'context-secret']),
            ),
            idempotencyKey: $key,
        );
    }
}

final class RunHandler implements OperationHandler
{
    public int $executions = 0;
    public ?object $receivedInput = null;
    public ?RunContext $retainedContext = null;

    /** @param class-string|null $inputClass */
    public function __construct(
        private bool $fail = false,
        private ?string $inputClass = null,
    ) {
    }

    public function definition(): OperationDefinition
    {
        return new OperationDefinition(
            'test.echo',
            'feature',
            'Echo',
            null,
            JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'required' => ['message'],
                'properties' => ['message' => ['type' => 'string']],
                'additionalProperties' => false,
            ]),
            null,
            null,
            null,
            [],
            [],
            new ExecutionPolicy(OperationImpact::READ, false, false, 'optional', false),
            new OperationOutput(JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'additionalProperties' => false,
            ])),
            inputClass: $this->inputClass,
        );
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        ++$this->executions;
        $this->receivedInput = $input;
        $this->retainedContext = $context;
        if ($this->fail) {
            throw new \RuntimeException('private handler detail');
        }

        return new OperationResult(JsonOwnership::object([]), ['title' => 'OK', 'tone' => 'success']);
    }
}

final class HostileRunStore implements RunStore
{
    public function __construct(private readonly Run $wrong)
    {
    }

    public function createQueued(Run $run, ?string $idempotencyFingerprint = null): RunStoreCreateResult
    {
        return RunStoreCreateResult::duplicate($this->wrong);
    }

    public function get(string $runId): ?Run
    {
        return $this->wrong;
    }

    public function findByIdempotencyFingerprint(string $operationId, string $fingerprint): ?Run
    {
        return $this->wrong;
    }

    public function updateExactSequence(Run $run, int $expectedPreviousSequence): bool
    {
        return false;
    }
}

final readonly class RunInput
{
    public function __construct(public string $message)
    {
    }
}

final class RunInputMapper implements InputMapper
{
    public int $calls = 0;

    public function map(JsonObject $input, string $class): object
    {
        ++$this->calls;
        if ($class !== RunInput::class) {
            throw new \LogicException('Unexpected input class.');
        }
        $value = $input->jsonSerialize();

        return new RunInput($value->message);
    }
}
