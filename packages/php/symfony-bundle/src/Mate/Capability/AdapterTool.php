<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Mate\Capability;

use EightLines\Gauntlet\SymfonyBundle\Mate\AdapterContainerReader;
use Symfony\AI\Mate\Attribute\MateTool;
use Symfony\AI\Mate\Encoding\ResponseEncoder;

/**
 * Symfony AI Mate capability. Mate discovers it through extra.ai-mate in the
 * bundle's composer.json; the application never registers it.
 */
final readonly class AdapterTool
{
    public function __construct(private AdapterContainerReader $reader)
    {
    }

    /**
     * @param string|null $environment Symfony environment whose cache to read (dev, test or prod); the first one found is used when empty
     * @param int         $limit       Maximum number of services listed per group
     */
    #[MateTool(
        name: 'gauntlet-adapter',
        title: 'Gauntlet Adapter',
        description: 'Show how the Gauntlet Symfony adapter is wired in the compiled container: whether GauntletBundle is registered, the enabled flag (or the env var it comes from), application identity, profiles, and the registered features, operations, data sources and capability endpoints with their classes. Reads the debug container from var/cache without booting the application; warm the cache first if it is missing.',
    )]
    public function inspect(?string $environment = null, int $limit = 100): string
    {
        return ResponseEncoder::encodeUntrusted($this->reader->read($environment, $limit));
    }
}
