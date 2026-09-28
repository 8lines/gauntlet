<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Contract;

use EightLines\Gauntlet\Core\Json\JsonObject;

interface InputMapper
{
    /** @param class-string $class */
    public function map(JsonObject $input, string $class): object;
}
