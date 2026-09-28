<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Result\FileReference;
use EightLines\Gauntlet\SymfonyBundle\Capability\UploadEndpoint;
use Symfony\Component\HttpFoundation\File\UploadedFile;

final class HostileUploadEndpoint implements UploadEndpoint
{
    public function upload(UploadedFile $file): JsonObject|Problem
    {
        $document = [
            'file' => [
                'kind' => 'file',
                'uploadId' => 'hostile-upload',
                'name' => $file->getClientOriginalName(),
                'mediaType' => 'text/plain',
                'sizeBytes' => 1,
                'expiresAt' => '2030-01-01T00:00:00Z',
            ],
        ];

        return match ($file->getClientOriginalName()) {
            'missing.txt' => new JsonObject(['file' => array_diff_key(
                $document['file'],
                ['expiresAt' => true],
            )]),
            'extra.txt' => new JsonObject([...$document, 'private' => 'upload-secret-731904']),
            'scalar.txt' => new JsonObject(['file' => [
                ...$document['file'],
                'sizeBytes' => NAN,
            ]]),
            default => new JsonObject($document),
        };
    }

    public function validate(FileReference $reference, string $operationId, string $revision): bool
    {
        return false;
    }
}
