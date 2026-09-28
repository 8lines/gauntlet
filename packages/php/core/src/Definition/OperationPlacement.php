<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Definition;

use EightLines\Gauntlet\Core\Protocol\ProtocolId;

final readonly class OperationPlacement
{
    /** @param array<string, string> $bindings */
    private function __construct(
        public string $kind,
        public ?string $subjectType,
        public array $bindings,
    ) {
    }

    public static function global(): self
    {
        return new self('global', null, []);
    }

    /** @param array<string, string> $bindings */
    public static function subject(string $subjectType, array $bindings = []): self
    {
        ProtocolId::assert($subjectType);
        foreach ($bindings as $key) {
            ProtocolId::assert($key);
        }

        return new self('subject', $subjectType, $bindings);
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        if ($this->kind === 'global') {
            return ['kind' => 'global'];
        }
        $document = ['kind' => 'subject', 'subjectType' => $this->subjectType];
        if ($this->bindings !== []) {
            $document['bindings'] = $this->bindings;
        }

        return $document;
    }
}
