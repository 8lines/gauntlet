<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\DataSource;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Run\InvocationContext;

final readonly class DataSourceResolveRequest
{
    /** @param list<string> $values */
    public function __construct(
        public array $values,
        public JsonObject $dependencies,
        public ?InvocationContext $context = null,
        public ?ProtocolExtensions $extensions = null,
    ) {
        foreach ($values as $value) {
            if (!is_string($value)) {
                throw new \InvalidArgumentException('Resolve values must be strings.');
            }
        }
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = ['values' => $this->values, 'dependencies' => $this->dependencies];
        if ($this->context !== null) {
            $document['context'] = $this->context->toProtocolArray();
        }
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }
}
