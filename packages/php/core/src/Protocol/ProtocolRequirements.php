<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Protocol;

final readonly class ProtocolRequirements
{
    /**
     * @param list<string> $profiles
     * @param list<string> $capabilities
     */
    public function __construct(
        public array $profiles = [],
        public array $capabilities = [],
    ) {
        ProtocolValue::assertUniqueStrings($profiles, 'required profiles', true);
        ProtocolValue::assertUniqueStrings($capabilities, 'required capabilities', true);
    }

    /** @return array{profiles?: list<string>, capabilities?: list<string>} */
    public function toProtocolArray(): array
    {
        $document = [];
        if ($this->profiles !== []) {
            $document['profiles'] = $this->profiles;
        }
        if ($this->capabilities !== []) {
            $document['capabilities'] = $this->capabilities;
        }

        return $document;
    }
}
