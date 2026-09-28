<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

use EightLines\Gauntlet\Core\Problem\Problem;

final readonly class RunCreationResult
{
    private function __construct(
        public ?Run $run,
        public ?Problem $problem,
    ) {
        if (($run === null) === ($problem === null)) {
            throw new \LogicException('A run creation result must contain exactly one outcome.');
        }
    }

    public static function success(Run $run): self
    {
        return new self($run, null);
    }

    public static function failure(Problem $problem): self
    {
        return new self(null, $problem);
    }

    public function isSuccess(): bool
    {
        return $this->run !== null;
    }
}
