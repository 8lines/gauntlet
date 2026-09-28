<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Contract;

use EightLines\Gauntlet\Core\Result\FileReference;

interface FileReferenceValidator
{
    public function validate(
        FileReference $reference,
        string $operationId,
        string $revision,
    ): bool;
}
