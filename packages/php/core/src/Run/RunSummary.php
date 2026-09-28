<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolValue;

final readonly class RunSummary
{
    public function __construct(
        public string $title,
        public string $tone = 'neutral',
        public ?string $message = null,
        public ?ProtocolExtensions $extensions = null,
    ) {
        ProtocolValue::assertNonBlank($title, 'Run summary title');
        if (!in_array($tone, ['neutral', 'success', 'warning', 'error'], true)) {
            throw new \InvalidArgumentException('Invalid run summary tone.');
        }
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = ['title' => $this->title, 'tone' => $this->tone];
        if ($this->message !== null) {
            $document['message'] = $this->message;
        }
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }
}
