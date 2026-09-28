<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Support;

use EightLines\Gauntlet\Core\Protocol\EnvironmentDescriptor;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;

final readonly class AdapterConfiguration
{
    private const VERSIONED_ID_PATTERN = '/^[A-Za-z0-9][A-Za-z0-9._:-]*@[1-9][0-9]*$/D';

    public ?EnvironmentDescriptor $environment;

    /** @param list<string> $profiles */
    public function __construct(
        public bool $enabled,
        public ?string $applicationId,
        public ?string $applicationLabel,
        ?string $environmentName,
        ?string $environmentKind,
        public array $profiles,
        public string $idempotencySecret,
        public int $maxJsonBytes = 1_048_576,
    ) {
        $environment = null;
        if ($enabled) {
            if ($applicationId === null || $applicationLabel === null || trim($applicationLabel) === '') {
                throw new \InvalidArgumentException('Enabled adapter requires application identity.');
            }
            ProtocolId::assert($applicationId);
            $environment = EnvironmentDescriptor::fromProtocolValue([
                'name' => $environmentName,
                'kind' => $environmentKind,
            ]);
        }
        $this->environment = $environment;

        if ($enabled && strlen($idempotencySecret) < 32) {
            throw new \InvalidArgumentException('Enabled adapter idempotency secret must contain at least 32 bytes.');
        }
        if ($maxJsonBytes < 1) {
            throw new \InvalidArgumentException('JSON body limit must be positive.');
        }
        if (count($profiles) !== count(array_unique($profiles))) {
            throw new \InvalidArgumentException('Profiles must be unique.');
        }
        foreach ($profiles as $profile) {
            if (!is_string($profile) || preg_match(self::VERSIONED_ID_PATTERN, $profile) !== 1) {
                throw new \InvalidArgumentException('Invalid versioned profile ID.');
            }
        }
    }

    /** @return array{id: string, label: string, environment: array{name: string, kind: string}} */
    public function application(): array
    {
        if (!$this->enabled
            || $this->applicationId === null
            || $this->applicationLabel === null
            || $this->environment === null) {
            throw new \LogicException('Disabled adapter has no public application document.');
        }

        return [
            'id' => $this->applicationId,
            'label' => $this->applicationLabel,
            'environment' => $this->environment->toProtocolArray(),
        ];
    }

    public function hasConfiguredCapabilities(): bool
    {
        return false;
    }
}
