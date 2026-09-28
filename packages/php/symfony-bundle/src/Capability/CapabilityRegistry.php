<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Capability;

use EightLines\Gauntlet\Core\Contract\CapabilityProvider;
use EightLines\Gauntlet\Core\Registry\RegistryDiagnostic;

final class CapabilityRegistry
{
    public const PROVIDER_TAG = 'gauntlet.capability_provider';

    /** @var array<string, object> */
    private array $endpoints = [];

    /** @var array<string, true> */
    private array $futureCapabilities = [];

    /** @var list<RegistryDiagnostic> */
    private array $diagnostics = [];

    /**
     * @param iterable<CapabilityProvider> $providers
     * @param iterable<CancelRunEndpoint> $cancelEndpoints
     * @param iterable<RunEventsEndpoint> $eventEndpoints
     * @param iterable<UploadEndpoint> $uploadEndpoints
     * @param iterable<SessionLaunchEndpoint> $sessionLaunchEndpoints
     */
    public function __construct(
        iterable $providers,
        iterable $cancelEndpoints,
        iterable $eventEndpoints,
        iterable $uploadEndpoints,
        iterable $sessionLaunchEndpoints,
    ) {
        $this->registerCancelEndpoint($cancelEndpoints);
        $this->registerEndpoint('tc-run-sse@1', RunEventsEndpoint::class, $eventEndpoints);
        $this->registerEndpoint('tc-uploads@1', UploadEndpoint::class, $uploadEndpoints);
        $this->registerEndpoint('tc-session-launch@1', SessionLaunchEndpoint::class, $sessionLaunchEndpoints);
        $this->registerProviders($providers);
    }

    /** @return list<string> */
    public function capabilities(): array
    {
        $capabilities = [...array_keys($this->endpoints), ...array_keys($this->futureCapabilities)];
        sort($capabilities, SORT_STRING);

        return $capabilities;
    }

    public function endpoint(string $capability): ?object
    {
        return $this->endpoints[$capability] ?? null;
    }

    /** @return list<RegistryDiagnostic> */
    public function diagnostics(): array
    {
        return $this->diagnostics;
    }

    /** @param class-string $expectedType */
    private function registerEndpoint(string $capability, string $expectedType, iterable $endpoints): void
    {
        $values = [];
        foreach ($endpoints as $endpoint) {
            if (!$endpoint instanceof $expectedType) {
                $this->diagnostics[] = new RegistryDiagnostic(
                    code: 'invalid_capability_endpoint',
                    message: 'A capability endpoint does not implement its required SPI.',
                );
                continue;
            }
            $values[] = $endpoint;
        }

        if (count($values) === 1) {
            $this->endpoints[$capability] = $values[0];

            return;
        }
        if (count($values) > 1) {
            $this->diagnostics[] = new RegistryDiagnostic(
                code: 'duplicate_capability_endpoint',
                message: 'A capability endpoint is registered more than once.',
            );
        }
    }

    /** @param iterable<CancelRunEndpoint> $endpoints */
    private function registerCancelEndpoint(iterable $endpoints): void
    {
        $managed = [];
        $custom = [];
        foreach ($endpoints as $endpoint) {
            if (!$endpoint instanceof CancelRunEndpoint) {
                $this->diagnostics[] = new RegistryDiagnostic(
                    code: 'invalid_capability_endpoint',
                    message: 'A capability endpoint does not implement its required SPI.',
                );
                continue;
            }
            if ($endpoint instanceof ManagedCancelRunEndpoint) {
                $managed[] = $endpoint;
            } else {
                $custom[] = $endpoint;
            }
        }

        if (count($managed) === 1) {
            if (count($custom) > 1) {
                $this->diagnostics[] = new RegistryDiagnostic(
                    code: 'duplicate_capability_endpoint',
                    message: 'A capability endpoint is registered more than once.',
                );
            }
            $this->endpoints['tc-run-cancellation@1'] = count($custom) === 1
                ? new ManagedFirstCancelRunEndpoint($managed[0], $custom[0])
                : $managed[0];

            return;
        }
        if (count($managed) > 1) {
            $this->diagnostics[] = new RegistryDiagnostic(
                code: 'duplicate_capability_endpoint',
                message: 'A capability endpoint is registered more than once.',
            );

            return;
        }

        if (count($custom) === 1) {
            $this->endpoints['tc-run-cancellation@1'] = $custom[0];

            return;
        }
        if (count($custom) > 1) {
            $this->diagnostics[] = new RegistryDiagnostic(
                code: 'duplicate_capability_endpoint',
                message: 'A capability endpoint is registered more than once.',
            );
        }
    }

    /** @param iterable<CapabilityProvider> $providers */
    private function registerProviders(iterable $providers): void
    {
        $blocked = [];
        foreach ($providers as $provider) {
            try {
                $capability = $provider->capabilityId();
                if (preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]*@[1-9][0-9]*$/D', $capability) !== 1) {
                    throw new \InvalidArgumentException('Invalid capability ID.');
                }
                if (str_starts_with($capability, 'tc-run-cancellation@')
                    || str_starts_with($capability, 'tc-run-sse@')
                    || str_starts_with($capability, 'tc-uploads@')
                    || str_starts_with($capability, 'tc-session-launch@')) {
                    $this->diagnostics[] = new RegistryDiagnostic(
                        code: 'core_capability_requires_endpoint_spi',
                        message: 'A core capability requires its endpoint SPI.',
                    );
                    continue;
                }
                if (isset($this->futureCapabilities[$capability]) || isset($blocked[$capability])) {
                    unset($this->futureCapabilities[$capability]);
                    $blocked[$capability] = true;
                    $this->diagnostics[] = new RegistryDiagnostic(
                        code: 'duplicate_capability_provider',
                        message: 'A capability provider is registered more than once.',
                    );
                    continue;
                }
                $this->futureCapabilities[$capability] = true;
            } catch (\Throwable) {
                $this->diagnostics[] = new RegistryDiagnostic(
                    code: 'invalid_capability_provider',
                    message: 'A capability provider is invalid.',
                );
            }
        }
    }
}
