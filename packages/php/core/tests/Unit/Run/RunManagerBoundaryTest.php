<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Run;

use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Contract\RunStore;
use EightLines\Gauntlet\Core\Definition\ExecutionPolicy;
use EightLines\Gauntlet\Core\Definition\InputHandling;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Definition\OperationOutput;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Json\JsonValue;
use EightLines\Gauntlet\Core\Problem\ValidationError;
use EightLines\Gauntlet\Core\Registry\OperationRegistry;
use EightLines\Gauntlet\Core\Result\Artifact;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\Core\Run\CreateRunRequest;
use EightLines\Gauntlet\Core\Run\FollowUpAction;
use EightLines\Gauntlet\Core\Run\InMemoryRunStore;
use EightLines\Gauntlet\Core\Run\Run;
use EightLines\Gauntlet\Core\Run\RunManager;
use EightLines\Gauntlet\Core\Run\RunProgress;
use EightLines\Gauntlet\Core\Run\RunStatus;
use EightLines\Gauntlet\Core\Run\RunStoreCreateResult;
use EightLines\Gauntlet\Core\Schema\OpisSchemaValidator;
use EightLines\Gauntlet\Core\Schema\SchemaValidator;
use EightLines\Gauntlet\Core\Schema\TcSchemaCore;
use PHPUnit\Framework\TestCase;

final class RunManagerBoundaryTest extends TestCase
{
    public function testAbsentContextIsValidatedAsAnEmptyObjectWhenTheDefinitionHasAContextSchema(): void
    {
        $handler = new BoundaryHandler('plain', requireContext: true);
        $store = new InMemoryRunStore();
        $result = self::manager([$handler], $store)->create(
            $handler->definition()->id,
            self::request($handler, null),
        );

        self::assertSame(422, $result->problem?->status);
        self::assertSame('urn:gauntlet:problem:validation-failed', $result->problem?->type);
        self::assertSame(0, $handler->executions);
        self::assertSame([], $store->all());
    }

    public function testThirtyTwoInterleavedDuplicateCreatesExecuteOnceAfterAtomicReservation(): void
    {
        $handler = new BoundaryHandler('plain');
        $store = new ReentrantBoundaryStore();
        $manager = self::manager([$handler], $store);
        $results = [];
        $store->afterFirstReservation = static function () use (&$results, $manager, $handler): void {
            for ($attempt = 0; $attempt < 31; ++$attempt) {
                $results[] = $manager->create(
                    $handler->definition()->id,
                    self::request($handler, 'raw-key-never-stored'),
                );
            }
        };
        $results[] = $manager->create(
            $handler->definition()->id,
            self::request($handler, 'raw-key-never-stored'),
        );
        $runIds = array_map(static function ($result): ?string {
            self::assertTrue($result->isSuccess());

            return $result->run?->id;
        }, $results);

        self::assertCount(32, $results);
        self::assertCount(1, array_unique($runIds));
        self::assertSame(1, $handler->executions);
        self::assertFalse($store->containsText('raw-key-never-stored'));
        self::assertSame(
            [0, 1, 2],
            array_map(static fn (Run $run): int => $run->sequence, $store->snapshots($runIds[0])),
        );
        self::assertSame(
            ['queued', 'running', 'succeeded'],
            array_map(static fn (Run $run): string => $run->state->value, $store->snapshots($runIds[0])),
        );
    }

    public function testRichContextAndResultProjectionPersistsInTheExactTerminalSnapshotOrder(): void
    {
        $handler = new BoundaryHandler('rich');
        $store = new InMemoryRunStore();
        $result = self::manager([$handler], $store)->create(
            $handler->definition()->id,
            self::request($handler, 'rich-key'),
        );

        self::assertTrue($result->isSuccess());
        $snapshots = $store->snapshots($result->run?->id ?? 'missing');
        self::assertSame(range(0, 9), array_map(static fn (Run $run): int => $run->sequence, $snapshots));
        self::assertSame(
            ['queued', 'running', 'running', 'running', 'running', 'running', 'running', 'running', 'running', 'succeeded'],
            array_map(static fn (Run $run): string => $run->state->value, $snapshots),
        );
        self::assertNull($snapshots[1]->progress);
        self::assertSame('Half way', $snapshots[2]->progress?->message);
        self::assertSame([], $snapshots[2]->artifacts);
        self::assertSame(['browser'], array_column($snapshots[3]->toProtocolArray()['artifacts'], 'id'));
        self::assertSame(['browser-launch'], array_column($snapshots[4]->toProtocolArray()['actions'], 'kind'));
        self::assertSame(
            ['browser-launch', 'urn:gauntlet:artifact:structured-log'],
            array_column($snapshots[5]->toProtocolArray()['artifacts'], 'kind'),
        );
        self::assertSame(
            ['browser-launch', 'urn:gauntlet:artifact:structured-log', 'notice', 'notice'],
            array_column($snapshots[7]->toProtocolArray()['artifacts'], 'kind'),
        );
        self::assertSame(
            ['browser-launch', 'open-link'],
            array_column($snapshots[8]->toProtocolArray()['actions'], 'kind'),
        );
        self::assertSame('Done', $snapshots[9]->summary?->title);
        self::assertSame(['ok' => true], $snapshots[9]->output?->values());
    }

    public function testMergedProjectionDuplicatesAndSourceSecretLeaksFailBeforeTerminalPersistence(): void
    {
        foreach ([
            'duplicate',
            'output-secret',
            'artifact-secret',
            'action-secret',
            'log-secret',
            'warning-secret',
            'progress-secret',
            'progress-overwritten-secret',
            'summary-secret',
            'key-secret',
            'scalar-secret',
        ] as $mode) {
            $handler = new BoundaryHandler($mode);
            $store = new InMemoryRunStore();
            $secret = $mode === 'scalar-secret' ? 424242 : BoundaryHandler::SECRET;
            $result = self::manager([$handler], $store)->create(
                $handler->definition()->id,
                self::request($handler, $mode, $secret),
            );

            self::assertSame('failed', $result->run?->state->value, $mode);
            self::assertSame(500, $result->run?->problem?->status, $mode);
            self::assertSame(
                'urn:gauntlet:problem:adapter-internal-error',
                $result->run?->problem?->type,
                $mode,
            );
            self::assertFalse($store->containsText((string) $secret), $mode);
            self::assertSame([], $result->run?->artifacts, $mode);
            self::assertSame([], $result->run?->actions, $mode);
            self::assertNull($result->run?->output, $mode);
        }
    }

    public function testProducerProgressAboveTotalFailsBeforeAnInvalidSnapshotIsPersisted(): void
    {
        $handler = new BoundaryHandler('invalid-progress');
        $store = new InMemoryRunStore();
        $result = self::manager([$handler], $store)->create(
            $handler->definition()->id,
            self::request($handler, 'invalid-progress'),
        );

        self::assertSame(RunStatus::FAILED, $result->run?->state);
        self::assertSame(500, $result->run?->problem?->status);
        foreach ($store->snapshots($result->run?->id ?? 'missing') as $snapshot) {
            self::assertFalse(
                $snapshot->progress !== null
                && $snapshot->progress->current !== null
                && $snapshot->progress->total !== null
                && $snapshot->progress->current > $snapshot->progress->total,
            );
        }
    }

    public function testFractionalProgressSurvivesProducerAndStoreBoundaries(): void
    {
        $handler = new BoundaryHandler('fractional-progress');
        $store = new InMemoryRunStore();
        $created = self::manager([$handler], $store)->create(
            $handler->definition()->id,
            self::request($handler, 'fractional-progress'),
        );

        self::assertSame(RunStatus::SUCCEEDED, $created->run?->state);
        self::assertSame(0.25, $created->run?->progress?->current);
        self::assertSame(1.5, $created->run?->progress?->total);
        self::assertSame(
            $created->run,
            self::manager([$handler], new FixedRunStore($created->run))->get($created->run?->id ?? 'missing'),
        );
    }

    public function testProducerPersistsEveryJsonOutputShapeAndDistinguishesNullFromAbsence(): void
    {
        foreach ([
            'object' => '{"answer":42}',
            'list' => '[1,"two"]',
            'null' => 'null',
            'boolean' => 'true',
            'string' => '"done"',
            'number' => '2.5',
            'absent' => null,
        ] as $mode => $expected) {
            $handler = new JsonValueBoundaryHandler($mode);
            $store = new InMemoryRunStore();
            $manager = self::manager([$handler], $store);
            $result = $manager->create(
                $handler->definition()->id,
                self::jsonValueRequest($handler),
            );

            self::assertSame(RunStatus::SUCCEEDED, $result->run?->state, $mode);
            self::assertSame(
                $result->run,
                $manager->get($result->run?->id ?? 'missing'),
                $mode,
            );
            $wire = JsonOwnership::transport(JsonOwnership::object(
                $result->run?->toProtocolArray() ?? [],
            ));
            if ($expected === null) {
                self::assertFalse(property_exists($wire, 'output'), $mode);
            } else {
                self::assertTrue(property_exists($wire, 'output'), $mode);
                self::assertSame($expected, json_encode(
                    $wire->output,
                    JSON_THROW_ON_ERROR
                        | JSON_UNESCAPED_SLASHES
                        | JSON_UNESCAPED_UNICODE
                        | JSON_PRESERVE_ZERO_FRACTION,
                ), $mode);
            }
        }
    }

    public function testScalarOutputsStillEnforceSchemasAndSourceSecretRetention(): void
    {
        foreach (['invalid-schema', 'secret'] as $mode) {
            $handler = new JsonValueBoundaryHandler($mode);
            $store = new InMemoryRunStore();
            $result = self::manager([$handler], $store)->create(
                $handler->definition()->id,
                self::jsonValueRequest($handler),
            );

            self::assertSame(RunStatus::FAILED, $result->run?->state, $mode);
            self::assertSame(500, $result->run?->problem?->status, $mode);
            self::assertNull($result->run?->output, $mode);
            self::assertFalse($store->containsText(JsonValueBoundaryHandler::SECRET), $mode);
        }
    }

    public function testEveryStoreReadValidatesCurrentDefinitionOutputArtifactsAndActions(): void
    {
        $handler = new BoundaryHandler('plain');
        $definition = $handler->definition();
        $now = '2026-08-30T10:00:00Z';
        $invalidRuns = [
            new Run(
                'bad-output',
                $definition->id,
                $definition->revision(),
                2,
                RunStatus::SUCCEEDED,
                $now,
                $now,
                $now,
                $now,
                output: JsonOwnership::object(['ok' => 'not-a-boolean']),
            ),
            new Run(
                'dangling-action',
                $definition->id,
                $definition->revision(),
                2,
                RunStatus::SUCCEEDED,
                $now,
                $now,
                $now,
                $now,
                output: JsonOwnership::object(['ok' => true]),
                actions: [FollowUpAction::browserLaunch('Open', 'missing-artifact')],
            ),
            new Run(
                'unknown-operation',
                'unknown.operation',
                'sha256:' . str_repeat('a', 64),
                2,
                RunStatus::SUCCEEDED,
                $now,
                $now,
                $now,
                $now,
                output: JsonOwnership::object(['ok' => true]),
            ),
            new Run(
                'backwards-time',
                $definition->id,
                $definition->revision(),
                2,
                RunStatus::SUCCEEDED,
                $now,
                '2026-08-30T09:59:58Z',
                '2026-08-30T09:59:59Z',
                '2026-08-30T09:59:58Z',
                output: JsonOwnership::object(['ok' => true]),
            ),
            new Run(
                'future-progress',
                $definition->id,
                $definition->revision(),
                2,
                RunStatus::SUCCEEDED,
                $now,
                '2026-08-30T10:00:01Z',
                $now,
                '2026-08-30T10:00:01Z',
                new \EightLines\Gauntlet\Core\Run\RunProgress(
                    1,
                    1,
                    'Impossible',
                    '2026-08-30T10:00:02Z',
                ),
                output: JsonOwnership::object(['ok' => true]),
            ),
            new Run(
                'future-completion',
                $definition->id,
                $definition->revision(),
                2,
                RunStatus::SUCCEEDED,
                $now,
                '2026-08-30T10:00:01Z',
                $now,
                '2026-08-30T10:00:02Z',
                output: JsonOwnership::object(['ok' => true]),
            ),
            new Run(
                'invalid-progress-bounds',
                $definition->id,
                $definition->revision(),
                2,
                RunStatus::SUCCEEDED,
                $now,
                $now,
                $now,
                $now,
                self::forgedProgress(2, 1, $now),
                output: JsonOwnership::object(['ok' => true]),
            ),
            new Run(
                'negative-zero-progress',
                $definition->id,
                $definition->revision(),
                2,
                RunStatus::SUCCEEDED,
                $now,
                $now,
                $now,
                $now,
                self::forgedProgress(-0.0, 1.0, $now),
                output: JsonOwnership::object(['ok' => true]),
            ),
            new Run(
                'non-finite-progress',
                $definition->id,
                $definition->revision(),
                2,
                RunStatus::SUCCEEDED,
                $now,
                $now,
                $now,
                $now,
                self::forgedProgress(NAN, 1.0, $now),
                output: JsonOwnership::object(['ok' => true]),
            ),
        ];

        foreach ($invalidRuns as $run) {
            $manager = self::manager([$handler], new FixedRunStore($run));
            self::assertNull($manager->get($run->id), $run->id);
        }
    }

    public function testSuccessfulStoredRunWithoutOutputRemainsReadable(): void
    {
        $handler = new BoundaryHandler('plain');
        $definition = $handler->definition();
        $now = '2026-08-30T10:00:00Z';
        $run = new Run(
            'no-output',
            $definition->id,
            $definition->revision(),
            2,
            RunStatus::SUCCEEDED,
            $now,
            $now,
            $now,
            $now,
        );

        self::assertSame($run, self::manager([$handler], new FixedRunStore($run))->get($run->id));
    }

    public function testInMemoryStoreRejectsTimestampRegressionWithoutAppendingASnapshot(): void
    {
        $store = new InMemoryRunStore();
        $queued = new Run(
            'chronology-run',
            'boundary.operation',
            'sha256:' . str_repeat('a', 64),
            0,
            RunStatus::QUEUED,
            '2026-08-30T10:00:00Z',
            '2026-08-30T10:00:00Z',
        );
        $store->createQueued($queued);
        $regressed = $queued->with([
            'sequence' => 1,
            'state' => RunStatus::RUNNING,
            'startedAt' => '2026-08-30T09:59:59Z',
            'updatedAt' => '2026-08-30T09:59:59Z',
        ]);

        self::assertFalse($store->updateExactSequence($regressed, 0));
        self::assertSame([0], array_map(
            static fn (Run $run): int => $run->sequence,
            $store->snapshots($queued->id),
        ));
    }

    public function testSchemaAndStoreFailuresAreSanitizedAndFailClosed(): void
    {
        $handler = new BoundaryHandler('plain');
        $throwingSchema = new RunManager(
            new OperationRegistry([$handler]),
            new InMemoryRunStore(),
            new ThrowingSchemaValidator(),
            str_repeat('s', 32),
        );
        $schemaFailure = $throwingSchema->create(
            $handler->definition()->id,
            self::request($handler, null),
        );
        self::assertSame('urn:gauntlet:problem:adapter-internal-error', $schemaFailure->problem?->type);

        foreach (['create', 'update'] as $stage) {
            $storeFailure = self::manager([$handler], new ThrowingBoundaryStore($stage))->create(
                $handler->definition()->id,
                self::request($handler, null),
            );
            self::assertSame('urn:gauntlet:problem:adapter-internal-error', $storeFailure->problem?->type, $stage);
            self::assertSame(500, $storeFailure->problem?->status, $stage);
        }
    }

    /** @param list<OperationHandler> $handlers */
    private static function manager(array $handlers, RunStore $store): RunManager
    {
        return new RunManager(
            new OperationRegistry($handlers),
            $store,
            new OpisSchemaValidator(),
            str_repeat('s', 32),
        );
    }

    private static function request(
        BoundaryHandler $handler,
        ?string $key,
        string|int $secret = BoundaryHandler::SECRET,
    ): CreateRunRequest {
        return new CreateRunRequest(
            $handler->definition()->revision(),
            JsonOwnership::object([
                'apiToken' => $secret,
            ]),
            idempotencyKey: $key,
        );
    }

    private static function jsonValueRequest(JsonValueBoundaryHandler $handler): CreateRunRequest
    {
        return new CreateRunRequest(
            $handler->definition()->revision(),
            JsonOwnership::object(['token' => JsonValueBoundaryHandler::SECRET]),
        );
    }

    private static function forgedProgress(
        int|float $current,
        int|float $total,
        string $updatedAt,
    ): RunProgress
    {
        $reflection = new \ReflectionClass(RunProgress::class);
        /** @var RunProgress $progress */
        $progress = $reflection->newInstanceWithoutConstructor();
        foreach ([
            'current' => $current,
            'total' => $total,
            'message' => 'Impossible',
            'updatedAt' => $updatedAt,
            'phase' => null,
            'extensions' => null,
        ] as $property => $value) {
            $reflection->getProperty($property)->setValue($progress, $value);
        }

        return $progress;
    }
}

final class BoundaryHandler implements OperationHandler
{
    public const SECRET = 'source-secret-sentinel';

    public int $executions = 0;

    public function __construct(
        private readonly string $mode,
        private readonly bool $requireContext = false,
    ) {
    }

    public function definition(): OperationDefinition
    {
        return new OperationDefinition(
            'boundary.operation',
            'feature',
            'Boundary operation',
            null,
            JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'required' => ['apiToken'],
                'properties' => [
                    'apiToken' => ['type' => ['string', 'integer']],
                ],
                'additionalProperties' => false,
            ]),
            new InputHandling([[
                'kind' => 'secret',
                'schemaPointer' => '/properties/apiToken',
                'retention' => 'none',
            ]]),
            $this->requireContext ? JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'required' => ['requestId'],
                'properties' => ['requestId' => ['type' => 'string']],
                'additionalProperties' => false,
            ]) : null,
            null,
            [],
            [],
            new ExecutionPolicy(OperationImpact::READ, false, false, 'optional', false),
            new OperationOutput(JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'required' => ['ok'],
                'properties' => [
                    'ok' => ['type' => 'boolean'],
                    'echo' => ['type' => 'string'],
                    'count' => ['type' => 'integer'],
                ],
                'additionalProperties' => false,
            ])),
        );
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        ++$this->executions;
        $output = JsonOwnership::object(['ok' => true]);
        $artifacts = [];
        $actions = [];
        $summary = null;

        if ($this->mode === 'duplicate') {
            $context->artifact(self::notice('duplicate-id', 'from context'));
            $artifacts[] = self::notice('duplicate-id', 'from result');
        } elseif ($this->mode === 'output-secret') {
            $output = JsonOwnership::object(['ok' => true, 'echo' => self::SECRET]);
        } elseif ($this->mode === 'artifact-secret') {
            $artifacts[] = self::notice('secret-artifact', self::SECRET);
        } elseif ($this->mode === 'action-secret') {
            $actions[] = FollowUpAction::openLink('Open', 'https://example.test/' . self::SECRET);
        } elseif ($this->mode === 'log-secret') {
            $context->log('info', self::SECRET);
        } elseif ($this->mode === 'warning-secret') {
            $context->warning('prefix-' . self::SECRET . '-suffix');
        } elseif ($this->mode === 'progress-secret') {
            $context->progress(1, 1, 'prefix-' . self::SECRET . '-suffix');
        } elseif ($this->mode === 'progress-overwritten-secret') {
            $context->progress(1, 2, 'prefix-' . self::SECRET . '-suffix');
            $context->progress(2, 2, 'Safe final progress');
        } elseif ($this->mode === 'summary-secret') {
            $summary = ['title' => 'Summary', 'message' => 'prefix-' . self::SECRET . '-suffix'];
        } elseif ($this->mode === 'key-secret') {
            $artifacts[] = new Artifact(
                'secret-key-artifact',
                'urn:test:artifact',
                JsonOwnership::object([
                    'data' => ['prefix-' . self::SECRET . '-suffix' => true],
                ]),
            );
        } elseif ($this->mode === 'scalar-secret') {
            $output = JsonOwnership::object(['ok' => true, 'count' => 424242]);
        } elseif ($this->mode === 'invalid-progress') {
            $context->progress(2, 1, 'Impossible');
        } elseif ($this->mode === 'fractional-progress') {
            $context->progress(0.25, 1.5, 'Fractional');
        } elseif ($this->mode === 'rich') {
            $context->progress(1, 2, 'Half way');
            $context->artifact(new Artifact('browser', 'browser-launch', JsonOwnership::object([
                'label' => 'Browser',
            ])));
            $context->action(FollowUpAction::browserLaunch('Open browser', 'browser'));
            $context->log('info', 'Working', JsonOwnership::object([
                'urn:example:step' => 1,
            ]));
            $context->warning('Watch this');
            $artifacts[] = self::notice('result-notice', 'Complete');
            $actions[] = FollowUpAction::openLink('Docs', 'https://example.test/docs');
            $summary = ['title' => 'Done', 'tone' => 'success'];
        }

        return new OperationResult($output, $summary, artifacts: $artifacts, actions: $actions);
    }

    private static function notice(string $id, string $message): Artifact
    {
        return new Artifact($id, 'notice', JsonOwnership::object([
            'level' => 'info',
            'message' => $message,
        ]));
    }
}

final class JsonValueBoundaryHandler implements OperationHandler
{
    public const SECRET = 'json-value-source-secret';

    public function __construct(private readonly string $mode)
    {
    }

    public function definition(): OperationDefinition
    {
        $outputSchema = [
            '$schema' => TcSchemaCore::DIALECT,
        ];
        if ($this->mode === 'invalid-schema') {
            $outputSchema['type'] = 'string';
        }

        return new OperationDefinition(
            'json-value.operation',
            'feature',
            'JSON value operation',
            null,
            JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'required' => ['token'],
                'properties' => ['token' => ['type' => 'string']],
                'additionalProperties' => false,
            ]),
            new InputHandling([[
                'kind' => 'secret',
                'schemaPointer' => '/properties/token',
                'retention' => 'none',
            ]]),
            null,
            null,
            [],
            [],
            new ExecutionPolicy(OperationImpact::READ, false, false, 'none', false),
            new OperationOutput(JsonOwnership::object($outputSchema)),
        );
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        if ($this->mode === 'absent') {
            return new OperationResult();
        }

        $value = match ($this->mode) {
            'object' => (object) ['answer' => 42],
            'list' => [1, 'two'],
            'null' => null,
            'boolean' => true,
            'string' => 'done',
            'number' => 2.5,
            'invalid-schema' => 42,
            'secret' => self::SECRET,
            default => throw new \LogicException('Unknown JSON value mode.'),
        };

        return new OperationResult(JsonOwnership::value($value));
    }
}

final class FixedRunStore implements RunStore
{
    public function __construct(private readonly Run $run)
    {
    }

    public function createQueued(Run $run, ?string $idempotencyFingerprint = null): RunStoreCreateResult
    {
        return RunStoreCreateResult::duplicate($this->run);
    }

    public function get(string $runId): ?Run
    {
        return $this->run;
    }

    public function findByIdempotencyFingerprint(string $operationId, string $fingerprint): ?Run
    {
        return $this->run;
    }

    public function updateExactSequence(Run $run, int $expectedPreviousSequence): bool
    {
        return false;
    }
}

final class ThrowingSchemaValidator implements SchemaValidator
{
    /** @return list<ValidationError> */
    public function validate(\EightLines\Gauntlet\Core\Json\JsonObject $schema, JsonValue $instance): array
    {
        throw new \RuntimeException('schema-secret-detail');
    }
}

final class ThrowingBoundaryStore implements RunStore
{
    private InMemoryRunStore $inner;

    public function __construct(private readonly string $stage)
    {
        $this->inner = new InMemoryRunStore();
    }

    public function createQueued(Run $run, ?string $idempotencyFingerprint = null): RunStoreCreateResult
    {
        if ($this->stage === 'create') {
            throw new \RuntimeException('store-create-secret-detail');
        }

        return $this->inner->createQueued($run, $idempotencyFingerprint);
    }

    public function get(string $runId): ?Run
    {
        return $this->inner->get($runId);
    }

    public function findByIdempotencyFingerprint(string $operationId, string $fingerprint): ?Run
    {
        return $this->inner->findByIdempotencyFingerprint($operationId, $fingerprint);
    }

    public function updateExactSequence(Run $run, int $expectedPreviousSequence): bool
    {
        if ($this->stage === 'update') {
            throw new \RuntimeException('store-update-secret-detail');
        }

        return $this->inner->updateExactSequence($run, $expectedPreviousSequence);
    }
}

final class ReentrantBoundaryStore implements RunStore
{
    public ?\Closure $afterFirstReservation = null;

    private InMemoryRunStore $inner;
    private bool $firstReservationOpen = true;

    public function __construct()
    {
        $this->inner = new InMemoryRunStore();
    }

    public function createQueued(Run $run, ?string $idempotencyFingerprint = null): RunStoreCreateResult
    {
        $reservation = $this->inner->createQueued($run, $idempotencyFingerprint);
        if ($reservation->created && $this->firstReservationOpen) {
            $this->firstReservationOpen = false;
            ($this->afterFirstReservation ?? static function (): void {
            })();
        }

        return $reservation;
    }

    public function get(string $runId): ?Run
    {
        return $this->inner->get($runId);
    }

    public function findByIdempotencyFingerprint(string $operationId, string $fingerprint): ?Run
    {
        return $this->inner->findByIdempotencyFingerprint($operationId, $fingerprint);
    }

    public function updateExactSequence(Run $run, int $expectedPreviousSequence): bool
    {
        return $this->inner->updateExactSequence($run, $expectedPreviousSequence);
    }

    /** @return list<Run> */
    public function snapshots(string $runId): array
    {
        return $this->inner->snapshots($runId);
    }

    public function containsText(string $text): bool
    {
        return $this->inner->containsText($text);
    }
}
