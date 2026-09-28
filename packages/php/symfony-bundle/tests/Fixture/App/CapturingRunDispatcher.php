<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Contract\RunDispatcher;
use EightLines\Gauntlet\Core\Run\ExecutionTask;

final class CapturingRunDispatcher implements RunDispatcher
{
    /** @var list<ExecutionTask> */
    public array $tasks = [];

    public function dispatch(ExecutionTask $task): void
    {
        $this->tasks[] = $task;
    }
}
