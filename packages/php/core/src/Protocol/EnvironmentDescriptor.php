<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Protocol;

final readonly class EnvironmentDescriptor
{
    private const PRODUCTION_TOKEN = '/(^|[._:-])(prod|production|live)($|[._:-])/iD';
    private const INVALID_MESSAGE = 'Invalid non-production environment descriptor';

    public function __construct(
        public string $name,
        public EnvironmentKind $kind,
    ) {
        try {
            ProtocolId::assert($name);
            if (preg_match(self::PRODUCTION_TOKEN, $name) !== 0) {
                throw self::invalid();
            }
        } catch (\Throwable) {
            throw self::invalid();
        }
    }

    public static function fromProtocolValue(mixed $value): self
    {
        if (!is_array($value)
            || count($value) !== 2
            || !array_key_exists('name', $value)
            || !array_key_exists('kind', $value)
            || !is_string($value['name'])
            || !is_string($value['kind'])) {
            throw self::invalid();
        }

        try {
            return new self($value['name'], EnvironmentKind::from($value['kind']));
        } catch (\Throwable) {
            throw self::invalid();
        }
    }

    /** @return array{name: string, kind: string} */
    public function toProtocolArray(): array
    {
        return ['name' => $this->name, 'kind' => $this->kind->value];
    }

    private static function invalid(): \InvalidArgumentException
    {
        return new \InvalidArgumentException(self::INVALID_MESSAGE);
    }
}
