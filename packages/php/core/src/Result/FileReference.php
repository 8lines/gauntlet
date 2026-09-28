<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Result;

use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;
use EightLines\Gauntlet\Core\Protocol\ProtocolValue;

final readonly class FileReference
{
    public function __construct(
        public string $uploadId,
        public string $name,
        public string $mediaType,
        public int $sizeBytes,
        public string $expiresAt,
        public ?string $sha256 = null,
        public ?ProtocolExtensions $extensions = null,
    ) {
        ProtocolId::assert($uploadId);
        ProtocolValue::assertNonBlank($name, 'File name');
        ProtocolValue::assertNonBlank($mediaType, 'File media type');
        if ($sizeBytes < 0 || $sizeBytes > ProtocolValue::MAX_SAFE_INTEGER) {
            throw new \InvalidArgumentException('Invalid file size.');
        }
        ProtocolValue::assertRfc3339($expiresAt);
        if ($sha256 !== null) {
            ProtocolId::assertRevision($sha256);
        }
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = [
            'kind' => 'file',
            'uploadId' => $this->uploadId,
            'name' => $this->name,
            'mediaType' => $this->mediaType,
            'sizeBytes' => $this->sizeBytes,
            'expiresAt' => $this->expiresAt,
        ];
        if ($this->sha256 !== null) {
            $document['sha256'] = $this->sha256;
        }
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }
}
