<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;
use EightLines\Gauntlet\Core\Protocol\ProtocolValue;

final readonly class RunEvent
{
    public function __construct(
        public string $id,
        public int $sequence,
        public string $occurredAt,
        public Run $run,
        public ?ProtocolExtensions $extensions = null,
    ) {
        ProtocolId::assert($id);
        if ($sequence < 0 || $sequence > ProtocolValue::MAX_SAFE_INTEGER) {
            throw new \InvalidArgumentException('Invalid Run event sequence.');
        }
        ProtocolValue::assertRfc3339($occurredAt);
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = [
            'id' => $this->id,
            'sequence' => $this->sequence,
            'occurredAt' => $this->occurredAt,
            'type' => 'run.updated',
            'run' => $this->run->toProtocolArray(),
        ];
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }
}
