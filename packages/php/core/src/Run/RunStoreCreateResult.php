<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

final readonly class RunStoreCreateResult
{
    private function __construct(
        public Run $run,
        public bool $created,
    ) {
    }

    public static function created(Run $run): self
    {
        return new self($run, true);
    }

    public static function duplicate(Run $run): self
    {
        return new self($run, false);
    }
}
