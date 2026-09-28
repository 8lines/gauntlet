<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

use EightLines\Gauntlet\Core\Contract\RunDispatcher;

/** Backward-compatible dispatcher that completes work inside create(). */
final class InlineRunDispatcher implements RunDispatcher
{
    public function dispatch(ExecutionTask $task): void
    {
        if (!$task->run()) {
            throw new \LogicException('Inline execution cannot defer a queued task.');
        }
    }
}
