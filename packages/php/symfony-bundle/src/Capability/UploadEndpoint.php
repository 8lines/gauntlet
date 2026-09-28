<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Capability;

use EightLines\Gauntlet\Core\Contract\FileReferenceValidator;
use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Problem\Problem;
use Symfony\Component\HttpFoundation\File\UploadedFile;

interface UploadEndpoint extends FileReferenceValidator
{
    public const TAG = 'gauntlet.capability.upload';

    public function upload(UploadedFile $file): JsonObject|Problem;
}
