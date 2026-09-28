<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

enum RunStatus: string
{
    case QUEUED = 'queued';
    case RUNNING = 'running';
    case SUCCEEDED = 'succeeded';
    case FAILED = 'failed';
    case PARTIAL = 'partial';
    case CANCELLED = 'cancelled';
    case TIMED_OUT = 'timed_out';
    case EXPIRED = 'expired';
    public function terminal(): bool
    {
        return !in_array($this, [self::QUEUED,self::RUNNING], true);
    }
}
