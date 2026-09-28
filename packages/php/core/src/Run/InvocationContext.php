<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;

final readonly class InvocationContext
{
    public function __construct(
        public string $requestId,
        public ?JsonObject $target = null,
        public ?JsonObject $actor = null,
        public ?string $locale = null,
        public ?string $timeZone = null,
        public ?JsonObject $extensions = null,
    ) {
        ProtocolId::assert($requestId);
        self::assertIdentityObject($target, ['id', 'environment']);
        self::assertIdentityObject($actor, ['id', 'displayName']);
        if ($extensions !== null) {
            new ProtocolExtensions($extensions);
        }
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = ['requestId' => $this->requestId];
        foreach ([
            'locale' => $this->locale,
            'timeZone' => $this->timeZone,
            'actor' => $this->actor,
            'target' => $this->target,
            'extensions' => $this->extensions,
        ] as $key => $value) {
            if ($value !== null) {
                $document[$key] = $value;
            }
        }

        return $document;
    }

    public function toJsonObject(): JsonObject
    {
        return JsonOwnership::object($this->toProtocolArray());
    }

    /** @param list<string> $allowed */
    private static function assertIdentityObject(?JsonObject $value, array $allowed): void
    {
        if ($value === null) {
            return;
        }
        $record = $value->jsonSerialize();
        if (!property_exists($record, 'id') || !is_string($record->id)) {
            throw new \InvalidArgumentException('Context identity requires an ID.');
        }
        ProtocolId::assert($record->id);
        foreach (get_object_vars($record) as $key => $member) {
            if (!in_array($key, $allowed, true) || !is_string($member)) {
                throw new \InvalidArgumentException('Invalid invocation context member.');
            }
        }
    }
}
