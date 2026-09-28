<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Run;

use EightLines\Gauntlet\Core\Contract\FileReferenceValidator;
use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Definition\ExecutionPolicy;
use EightLines\Gauntlet\Core\Definition\InputHandling;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Definition\OperationOutput;
use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Registry\OperationRegistry;
use EightLines\Gauntlet\Core\Result\FileReference;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\Core\Run\ConfirmationAcknowledgement;
use EightLines\Gauntlet\Core\Run\CreateRunRequest;
use EightLines\Gauntlet\Core\Run\InMemoryRunStore;
use EightLines\Gauntlet\Core\Run\RunManager;
use EightLines\Gauntlet\Core\Schema\OpisSchemaValidator;
use EightLines\Gauntlet\Core\Schema\TcSchemaCore;
use PHPUnit\Framework\TestCase;

final class InputHandlingGuardTest extends TestCase
{
    public function testFileRuleThroughLocalReferenceRequiresCanonicalUploadCapability(): void
    {
        $handler = new FileRuleHandler();
        $result = self::manager($handler)->create('file.operation', self::request($handler, self::file()));

        self::assertSame(501, $result->problem?->status);
        self::assertSame('urn:gauntlet:problem:unsupported-capability', $result->problem?->type);
        self::assertSame('tc-uploads@1', $result->problem?->capability);
        self::assertSame(0, $handler->executions);
    }

    public function testFileRuleDelegatesExpiryAndOwnershipWithOperationRevisionToTheSpi(): void
    {
        $handler = new FileRuleHandler();
        $validator = new RecordingFileValidator(true);
        $result = self::manager($handler, $validator)->create(
            'file.operation',
            self::request($handler, self::file()),
        );

        self::assertTrue($result->isSuccess());
        self::assertSame(1, $validator->calls);
        self::assertSame('upload-1', $validator->reference?->uploadId);
        self::assertSame('file.operation', $validator->operationId);
        self::assertSame($handler->definition()->revision(), $validator->revision);

        $rejecting = new RecordingFileValidator(false);
        $rejected = self::manager(new FileRuleHandler(), $rejecting)->create(
            'file.operation',
            self::request($handler, self::file(expiresAt: '2020-01-01T00:00:00Z')),
        );
        self::assertSame(422, $rejected->problem?->status);
        self::assertSame(1, $rejecting->calls);
    }

    public function testFileRuleEnforcesCardinalityMediaTypeAndSizeBeforeDispatch(): void
    {
        foreach ([
            [(object) ['unexpected' => true], 'invalid-shape'],
            [[self::file()], 'invalid-cardinality'],
            [self::file(mediaType: 'text/plain'), 'invalid-media-type'],
            [self::file(sizeBytes: 101), 'invalid-size'],
        ] as [$file, $case]) {
            $handler = new FileRuleHandler();
            $validator = new RecordingFileValidator(true);
            $result = self::manager($handler, $validator)->create(
                'file.operation',
                self::request($handler, $file),
            );
            self::assertSame(422, $result->problem?->status, $case);
            self::assertSame(0, $handler->executions, $case);
        }
    }

    public function testPresentOptionalFileMembersMustKeepTheirDeclaredTypes(): void
    {
        foreach ([
            [self::file(sha256: 731904), 'invalid-sha256'],
            [self::file(extensions: null, includeExtensions: true), 'invalid-extensions'],
        ] as [$file, $case]) {
            $handler = new FileRuleHandler();
            $validator = new RecordingFileValidator(true);
            $result = self::manager($handler, $validator)->create(
                'file.operation',
                self::request($handler, $file),
            );

            self::assertSame(422, $result->problem?->status, $case);
            self::assertSame(0, $validator->calls, $case);
            self::assertSame(0, $handler->executions, $case);
        }
    }

    private static function manager(
        FileRuleHandler $handler,
        ?FileReferenceValidator $validator = null,
    ): RunManager {
        return new RunManager(
            new OperationRegistry([$handler]),
            new InMemoryRunStore(),
            new OpisSchemaValidator(),
            str_repeat('s', 32),
            fileReferenceValidator: $validator,
        );
    }

    private static function request(FileRuleHandler $handler, mixed $file): CreateRunRequest
    {
        $revision = $handler->definition()->revision();

        return new CreateRunRequest(
            $revision,
            JsonOwnership::object(['attachment' => $file]),
            confirmation: new ConfirmationAcknowledgement(
                'file.operation',
                $revision,
                OperationImpact::WRITE,
            ),
        );
    }

    private static function file(
        string $mediaType = 'application/pdf',
        int $sizeBytes = 100,
        string $expiresAt = '2030-01-01T00:00:00Z',
        mixed $sha256 = null,
        mixed $extensions = null,
        bool $includeExtensions = false,
    ): object {
        $file = [
            'kind' => 'file',
            'uploadId' => 'upload-1',
            'name' => 'document.pdf',
            'mediaType' => $mediaType,
            'sizeBytes' => $sizeBytes,
            'expiresAt' => $expiresAt,
        ];
        if ($sha256 !== null) {
            $file['sha256'] = $sha256;
        }
        if ($includeExtensions) {
            $file['extensions'] = $extensions;
        }

        return (object) $file;
    }
}

final class FileRuleHandler implements OperationHandler
{
    public int $executions = 0;

    public function definition(): OperationDefinition
    {
        return new OperationDefinition(
            'file.operation',
            'feature',
            'File operation',
            null,
            JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'required' => ['attachment'],
                'properties' => [
                    'attachment' => ['$ref' => '#/$defs/file'],
                ],
                '$defs' => [
                    'file' => [
                        'type' => 'object',
                        'required' => ['kind', 'uploadId', 'name', 'mediaType', 'sizeBytes', 'expiresAt'],
                        'properties' => [
                            'kind' => ['const' => 'file'],
                            'uploadId' => ['type' => 'string'],
                            'name' => ['type' => 'string'],
                            'mediaType' => ['type' => 'string'],
                            'sizeBytes' => ['type' => 'integer'],
                            'expiresAt' => ['type' => 'string'],
                            'sha256' => ['type' => ['string', 'integer']],
                            'extensions' => ['type' => ['object', 'null']],
                        ],
                        'additionalProperties' => false,
                    ],
                ],
                'additionalProperties' => false,
            ]),
            new InputHandling([[
                'kind' => 'file',
                'schemaPointer' => '/$defs/file',
                'multiple' => false,
                'mediaTypes' => ['application/pdf'],
                'maxBytes' => 100,
            ]]),
            null,
            null,
            [],
            [],
            new ExecutionPolicy(OperationImpact::WRITE, true, false, 'optional', false),
            new OperationOutput(JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'additionalProperties' => false,
            ])),
        );
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        ++$this->executions;

        return new OperationResult(JsonOwnership::object([]));
    }
}

final class RecordingFileValidator implements FileReferenceValidator
{
    public int $calls = 0;
    public ?FileReference $reference = null;
    public ?string $operationId = null;
    public ?string $revision = null;

    public function __construct(private readonly bool $accepted)
    {
    }

    public function validate(FileReference $reference, string $operationId, string $revision): bool
    {
        ++$this->calls;
        $this->reference = $reference;
        $this->operationId = $operationId;
        $this->revision = $revision;

        return $this->accepted;
    }
}
