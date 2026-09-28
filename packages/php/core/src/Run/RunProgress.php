<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolValue;

final readonly class RunProgress
{
    public function __construct(
        public int|float|null $current,
        public int|float|null $total,
        public ?string $message,
        public string $updatedAt,
        public ?string $phase = null,
        public ?ProtocolExtensions $extensions = null,
    ) {
        self::assertValue($current, 'current');
        self::assertValue($total, 'total');
        if ($current !== null && $total !== null && $current > $total) {
            throw new \InvalidArgumentException('Run progress current value exceeds total.');
        }
        ProtocolValue::assertRfc3339($updatedAt);
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = ['updatedAt' => $this->updatedAt];
        foreach ([
            'current' => $this->current,
            'total' => $this->total,
            'phase' => $this->phase,
            'message' => $this->message,
        ] as $key => $value) {
            if ($value !== null) {
                $document[$key] = $value;
            }
        }
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }

    private static function assertValue(int|float|null $value, string $name): void
    {
        if ($value === null) {
            return;
        }
        if (is_float($value)
            && (!is_finite($value) || ($value === 0.0 && fdiv(1.0, $value) === -INF))) {
            throw new \InvalidArgumentException('Run progress ' . $name . ' value is invalid.');
        }
        if ($value < 0) {
            throw new \InvalidArgumentException('Run progress ' . $name . ' value is invalid.');
        }
    }
}
