<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Contract;

use EightLines\Gauntlet\Core\Run\ExecutionTask;

/**
 * Dispatches an in-memory execution task without serializing its input.
 *
 * A scheduler may invoke a task before its FIFO turn is available. In that
 * case ExecutionTask::run() returns false and the same in-memory task must be
 * retried later. A true result means no further invocation is required.
 */
interface RunDispatcher
{
    public function dispatch(ExecutionTask $task): void;
}
