<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Contract;

use EightLines\Gauntlet\Core\Problem\ValidationError;

final class InputMappingException extends \RuntimeException
{
    /** @param list<ValidationError> $errors */
    public function __construct(public readonly array $errors)
    {
        foreach ($errors as $error) {
            if (!$error instanceof ValidationError) {
                throw new \InvalidArgumentException('Input mapping errors must be typed validation errors.');
            }
        }
        parent::__construct('Input mapping failed.');
    }
}
