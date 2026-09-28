<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\DataSource;

final readonly class DataSourceValue
{
    public function __construct(public string $value)
    {
    }

    public function __toString(): string
    {
        return $this->value;
    }
}
