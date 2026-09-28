<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Contract;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Result\Artifact;
use EightLines\Gauntlet\Core\Run\FollowUpAction;
use EightLines\Gauntlet\Core\Run\InvocationContext;

interface RunContext
{
    public function runId(): string;

    public function operationId(): string;

    public function isDryRun(): bool;

    public function invocationContext(): ?InvocationContext;

    public function isCancelled(): bool;

    public function progress(int|float|null $current, int|float|null $total, ?string $message = null): void;

    public function artifact(Artifact $artifact): void;

    public function action(FollowUpAction $action): void;

    public function log(string $level, string $message, ?JsonObject $context = null): void;

    public function warning(string $message): void;
}
