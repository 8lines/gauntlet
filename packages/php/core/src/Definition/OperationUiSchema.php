<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Definition;

use EightLines\Gauntlet\Core\Json\JsonObject;

final readonly class OperationUiSchema
{
    public function __construct(public JsonObject $value)
    {
    }

    public function toProtocolArray(): object
    {
        return $this->value->jsonSerialize();
    }
}
