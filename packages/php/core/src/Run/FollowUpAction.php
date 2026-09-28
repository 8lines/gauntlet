<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;
use EightLines\Gauntlet\Core\Protocol\ProtocolValue;

/** A validated member of the closed v1 FollowUpAction union. */
final readonly class FollowUpAction
{
    public function __construct(
        public string $kind,
        public string $label,
        public ?string $operationId = null,
        public ?JsonObject $input = null,
        public ?string $artifactId = null,
        public ?string $url = null,
    ) {
        ProtocolValue::assertNonBlank($label, 'Follow-up action label');
        match ($kind) {
            'invoke-operation' => $this->assertInvokeOperation(),
            'open-link' => $this->assertOpenLink(),
            'browser-launch' => $this->assertBrowserLaunch(),
            default => throw new \InvalidArgumentException('Unsupported follow-up action kind.'),
        };
    }

    public static function invokeOperation(string $label, string $operationId, ?JsonObject $input = null): self
    {
        return new self('invoke-operation', $label, operationId: $operationId, input: $input);
    }

    public static function openLink(string $label, string $url): self
    {
        return new self('open-link', $label, url: $url);
    }

    public static function browserLaunch(string $label, string $artifactId): self
    {
        return new self('browser-launch', $label, artifactId: $artifactId);
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = ['kind' => $this->kind, 'label' => $this->label];
        foreach ([
            'operationId' => $this->operationId,
            'input' => $this->input,
            'artifactId' => $this->artifactId,
            'url' => $this->url,
        ] as $key => $value) {
            if ($value !== null) {
                $document[$key] = $value;
            }
        }

        return $document;
    }

    private function assertInvokeOperation(): void
    {
        if ($this->operationId === null || $this->artifactId !== null || $this->url !== null) {
            throw new \InvalidArgumentException('Invalid invoke-operation action.');
        }
        ProtocolId::assert($this->operationId);
    }

    private function assertOpenLink(): void
    {
        if ($this->url === null || $this->operationId !== null || $this->input !== null || $this->artifactId !== null) {
            throw new \InvalidArgumentException('Invalid open-link action.');
        }
        ProtocolValue::assertHttpUrl($this->url);
    }

    private function assertBrowserLaunch(): void
    {
        if ($this->artifactId === null || $this->operationId !== null || $this->input !== null || $this->url !== null) {
            throw new \InvalidArgumentException('Invalid browser-launch action.');
        }
        ProtocolId::assert($this->artifactId);
    }
}
