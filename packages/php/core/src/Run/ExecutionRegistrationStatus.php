<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

enum ExecutionRegistrationStatus: string
{
    case READY = 'ready';
    case QUEUED = 'queued';
    case REJECTED = 'rejected';
    case DUPLICATE = 'duplicate';
}
