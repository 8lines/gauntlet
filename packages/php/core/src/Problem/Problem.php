<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Problem;

use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;
use EightLines\Gauntlet\Core\Protocol\ProtocolValue;

final readonly class Problem
{
    /** @param list<ValidationError> $errors */
    public function __construct(
        public string $type,
        public string $title,
        public int $status,
        public ?string $detail = null,
        public ?string $instance = null,
        public ?string $correlationId = null,
        public array $errors = [],
        public ?string $capability = null,
        public ?ProtocolExtensions $extensions = null,
    ) {
        if (preg_match('/^urn:gauntlet:problem:[A-Za-z0-9][A-Za-z0-9._:-]*$/D', $type) !== 1
            || $status < 100
            || $status > 599) {
            throw new \InvalidArgumentException('Invalid Gauntlet problem.');
        }
        ProtocolValue::assertNonBlank($title, 'Problem title');
        foreach ($errors as $error) {
            if (!$error instanceof ValidationError) {
                throw new \InvalidArgumentException('Problem errors must be typed validation errors.');
            }
        }
        if ($capability !== null) {
            ProtocolId::assertVersioned($capability);
        }
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = ['type' => $this->type, 'title' => $this->title, 'status' => $this->status];
        foreach ([
            'detail' => $this->detail,
            'instance' => $this->instance,
            'correlationId' => $this->correlationId,
            'capability' => $this->capability,
        ] as $key => $value) {
            if ($value !== null) {
                $document[$key] = $value;
            }
        }
        if ($this->errors !== []) {
            $document['errors'] = array_map(
                static fn (ValidationError $error): array => $error->toProtocolArray(),
                $this->errors,
            );
        }
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }

    /** @param list<ValidationError> $errors */
    public static function validation(array $errors, ?string $correlationId = null): self
    {
        return new self(
            'urn:gauntlet:problem:validation-failed',
            'Validation failed',
            422,
            correlationId: $correlationId,
            errors: $errors,
        );
    }
}
