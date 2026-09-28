<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Schema;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonValue;

interface SchemaValidator
{
    /** @return list<\EightLines\Gauntlet\Core\Problem\ValidationError> */
    public function validate(JsonObject $schema, JsonValue $instance): array;
}
