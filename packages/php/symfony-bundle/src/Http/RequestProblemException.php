<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Http;

use EightLines\Gauntlet\Core\Problem\Problem;

final class RequestProblemException extends \RuntimeException
{
    public function __construct(public readonly Problem $problem)
    {
        parent::__construct('Adapter request was rejected.');
    }
}
