<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Result;

use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Result\Artifact;
use EightLines\Gauntlet\Core\Result\FileReference;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\Core\Run\FollowUpAction;
use EightLines\Gauntlet\Core\Run\RunSummary;
use PHPUnit\Framework\TestCase;

final class ClosedResultTypesTest extends TestCase
{
    public function testKnownAndNamespacedArtifactsHaveClosedShapes(): void
    {
        $artifact = new Artifact('notice-1', 'notice', JsonOwnership::object([
            'level' => 'success',
            'message' => 'Done',
        ]));
        self::assertSame([
            'id' => 'notice-1',
            'kind' => 'notice',
            'level' => 'success',
            'message' => 'Done',
        ], $artifact->toProtocolArray());

        $namespaced = new Artifact('custom-1', 'urn:example:artifact', JsonOwnership::object([
            'data' => ['ok' => true],
        ]));
        self::assertSame('urn:example:artifact', $namespaced->toProtocolArray()['kind']);
    }

    public function testArtifactDataCannotOverrideIdentityOrAddUnknownMembers(): void
    {
        foreach ([
            ['kind' => 'notice', 'data' => ['id' => 'override', 'level' => 'info', 'message' => 'x']],
            ['kind' => 'notice', 'data' => ['level' => 'info', 'message' => 'x', 'url' => 'https://example.com']],
            ['kind' => 'browser-launch', 'data' => ['label' => 'Launch', 'url' => 'https://secret.invalid']],
        ] as $case) {
            try {
                new Artifact('artifact-1', $case['kind'], JsonOwnership::object($case['data']));
                self::fail('Expected the closed artifact union to reject the case.');
            } catch (\InvalidArgumentException) {
            }
        }
        self::addToAssertionCount(3);
    }

    public function testArtifactExtensionsRequireNamespacedProtocolKeys(): void
    {
        foreach (['notice', 'urn:example:artifact'] as $kind) {
            $payload = $kind === 'notice'
                ? ['level' => 'info', 'message' => 'Done', 'extensions' => ['bad' => true]]
                : ['data' => ['ok' => true], 'extensions' => ['bad' => true]];

            try {
                new Artifact('artifact-1', $kind, JsonOwnership::object($payload));
                self::fail('Artifact extensions must use namespaced protocol keys.');
            } catch (\InvalidArgumentException) {
                self::addToAssertionCount(1);
            }
        }

        $artifact = new Artifact('artifact-1', 'notice', JsonOwnership::object([
            'level' => 'info',
            'message' => 'Done',
            'extensions' => ['urn:example:trace' => ['sampled' => true]],
        ]));
        self::assertEquals(
            (object) ['urn:example:trace' => (object) ['sampled' => true]],
            $artifact->toProtocolArray()['extensions'],
        );
    }

    public function testOperationResultRequiresTypedSummaryArtifactsAndActions(): void
    {
        $result = new OperationResult(
            JsonOwnership::object(['ok' => true]),
            new RunSummary('Done', 'success'),
            [new Artifact('notice-1', 'notice', JsonOwnership::object(['level' => 'info', 'message' => 'Done']))],
            [FollowUpAction::openLink('Docs', 'https://example.com/docs')],
        );

        self::assertSame('success', $result->summary?->tone);

        $this->expectException(\InvalidArgumentException::class);
        new OperationResult(JsonOwnership::object([]), artifacts: [['kind' => 'notice']]);
    }

    public function testFileReferenceIsOpaqueMetadataOnly(): void
    {
        $reference = new FileReference(
            'upload-1',
            'report.txt',
            'text/plain',
            42,
            '2026-08-30T10:00:00Z',
            'sha256:' . str_repeat('a', 64),
        );
        self::assertSame('file', $reference->toProtocolArray()['kind']);

        $this->expectException(\InvalidArgumentException::class);
        new FileReference('bad/id', 'report.txt', 'text/plain', 42, '2026-08-30T10:00:00Z');
    }

    public function testCalendarInvalidFileExpiryAndRelativeHttpUrlsAreRejected(): void
    {
        try {
            new FileReference('upload-1', 'report.txt', 'text/plain', 42, '2026-02-30T10:00:00Z');
            self::fail('Calendar-invalid expiry must be rejected.');
        } catch (\InvalidArgumentException) {
            self::addToAssertionCount(1);
        }

        foreach ([
            static fn (): Artifact => new Artifact('link-1', 'link', JsonOwnership::object([
                'label' => 'Relative',
                'url' => 'http:relative',
            ])),
            static fn (): FollowUpAction => FollowUpAction::openLink('Relative', 'https:relative'),
        ] as $factory) {
            try {
                $factory();
                self::fail('Relative HTTP URL must be rejected.');
            } catch (\InvalidArgumentException) {
                self::addToAssertionCount(1);
            }
        }
    }
}
