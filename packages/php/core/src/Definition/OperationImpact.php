<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Definition;

enum OperationImpact: string
{
    case READ = 'read';
    case WRITE = 'write';
    case DESTRUCTIVE = 'destructive';
}
