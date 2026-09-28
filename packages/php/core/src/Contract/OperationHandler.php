<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Contract;

use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Result\OperationResult;

interface OperationHandler
{
    public const TAG = 'gauntlet.operation';

    public function definition(): OperationDefinition;

    public function execute(object $input, RunContext $context): OperationResult;
}
