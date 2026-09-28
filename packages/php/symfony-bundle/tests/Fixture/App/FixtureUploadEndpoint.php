<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Result\FileReference;
use EightLines\Gauntlet\SymfonyBundle\Capability\UploadEndpoint;
use Symfony\Component\HttpFoundation\File\UploadedFile;

final class FixtureUploadEndpoint implements UploadEndpoint
{
    public int $validationCalls = 0;

    public ?string $validatedOperationId = null;

    public ?string $validatedRevision = null;

    public function upload(UploadedFile $file): JsonObject|Problem
    {
        return JsonOwnership::object([
            'file' => [
                'kind' => 'file',
                'uploadId' => 'fixture-upload',
                'name' => $file->getClientOriginalName(),
                'mediaType' => $file->getClientMimeType(),
                'sizeBytes' => $file->getSize(),
                'expiresAt' => '2030-01-01T00:00:00Z',
            ],
        ]);
    }

    public function validate(FileReference $reference, string $operationId, string $revision): bool
    {
        ++$this->validationCalls;
        $this->validatedOperationId = $operationId;
        $this->validatedRevision = $revision;

        return $reference->uploadId === 'fixture-upload';
    }
}
