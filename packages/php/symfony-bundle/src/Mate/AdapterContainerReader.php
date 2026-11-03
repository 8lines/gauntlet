<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Mate;

use EightLines\Gauntlet\Core\Contract\DataSource;
use EightLines\Gauntlet\Core\Contract\FeatureProvider;
use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\SymfonyBundle\Capability\CancelRunEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Capability\CapabilityRegistry;
use EightLines\Gauntlet\SymfonyBundle\Capability\RunEventsEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Capability\SessionLaunchEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Capability\UploadEndpoint;

/**
 * Reads the Gauntlet adapter wiring from the debug container XML that Symfony
 * dumps into the cache directory, without booting the application.
 *
 * Only the gauntlet.enabled, gauntlet.application and gauntlet.profiles
 * parameters are read; the idempotency secret never leaves the container.
 */
final readonly class AdapterContainerReader
{
    private const ENVIRONMENTS = ['dev', 'test', 'prod'];

    private const GROUPS = [
        'features' => FeatureProvider::TAG,
        'operations' => OperationHandler::TAG,
        'data_sources' => DataSource::TAG,
        'capability_providers' => CapabilityRegistry::PROVIDER_TAG,
        'cancel_run_endpoints' => CancelRunEndpoint::TAG,
        'run_events_endpoints' => RunEventsEndpoint::TAG,
        'upload_endpoints' => UploadEndpoint::TAG,
        'session_launch_endpoints' => SessionLaunchEndpoint::TAG,
    ];

    private const PARAMETERS = [
        'enabled' => 'gauntlet.enabled',
        'application' => 'gauntlet.application',
        'profiles' => 'gauntlet.profiles',
    ];

    public function __construct(private string $cacheDir)
    {
    }

    /**
     * @return array{
     *     environment: string,
     *     container: string,
     *     bundle_registered: bool,
     *     enabled?: mixed,
     *     enabled_env?: string,
     *     application?: mixed,
     *     profiles?: mixed,
     *     services?: array<string, array{services: array<string, string|null>, count: int, truncated: bool}>,
     * }
     */
    public function read(?string $environment = null, int $limit = 100): array
    {
        [$environment, $path] = $this->locate($environment);
        $xml = $this->parse($path);

        $parameters = $this->parameters($xml);
        $report = [
            'environment' => $environment,
            'container' => basename($path),
            'bundle_registered' => array_key_exists(self::PARAMETERS['enabled'], $parameters),
        ];
        if (!$report['bundle_registered']) {
            return $report;
        }

        foreach (self::PARAMETERS as $key => $parameter) {
            $report[$key] = $parameters[$parameter] ?? null;
        }
        if (is_string($report['enabled'])
            && preg_match('/^%env\((?:[a-z_]+:)*([A-Za-z_][A-Za-z0-9_]*)\)%$/D', $report['enabled'], $match) === 1) {
            $report['enabled_env'] = $match[1];
        }

        $report['services'] = $this->services($xml, $limit);

        return $report;
    }

    /** @return array{string, string} */
    private function locate(?string $environment): array
    {
        if ($environment !== null && $environment !== '') {
            if (preg_match('/^[A-Za-z0-9_-]+$/D', $environment) !== 1) {
                throw new \InvalidArgumentException('The environment name may only contain letters, digits, "_" and "-".');
            }
            $candidates = [$environment];
        } else {
            $candidates = self::ENVIRONMENTS;
        }

        foreach ($candidates as $candidate) {
            $files = glob($this->cacheDir . '/' . $candidate . '/*DebugContainer.xml');
            if ($files !== false && $files !== []) {
                sort($files);

                return [$candidate, $files[0]];
            }
        }

        throw new \RuntimeException(sprintf(
            'No compiled debug container found for "%s" under "%s". Warm the cache with debug enabled, '
                . 'for example "bin/console cache:warmup --env=dev", then run this tool again.',
            implode('", "', $candidates),
            $this->cacheDir,
        ));
    }

    private function parse(string $path): \SimpleXMLElement
    {
        $contents = file_get_contents($path);
        $xml = $contents === false ? false : @simplexml_load_string($contents);
        if ($xml === false) {
            throw new \RuntimeException(sprintf('The container dump "%s" cannot be read.', basename($path)));
        }

        return $xml;
    }

    /** @return array<string, mixed> */
    private function parameters(\SimpleXMLElement $xml): array
    {
        $parameters = [];
        foreach ($xml->parameters->parameter ?? [] as $parameter) {
            $key = (string) $parameter['key'];
            if (in_array($key, self::PARAMETERS, true)) {
                $parameters[$key] = $this->parameterValue($parameter);
            }
        }

        return $parameters;
    }

    private function parameterValue(\SimpleXMLElement $parameter): mixed
    {
        $type = (string) $parameter['type'];
        if ($type === 'collection') {
            $values = [];
            foreach ($parameter->parameter as $child) {
                if (isset($child['key'])) {
                    $values[(string) $child['key']] = $this->parameterValue($child);
                } else {
                    $values[] = $this->parameterValue($child);
                }
            }

            return $values;
        }

        $text = (string) $parameter;
        if ($type !== '') {
            return $text;
        }

        return match (strtolower($text)) {
            'true' => true,
            'false' => false,
            'null' => null,
            default => is_numeric($text) ? $text + 0 : $text,
        };
    }

    /** @return array<string, array{services: array<string, string|null>, count: int, truncated: bool}> */
    private function services(\SimpleXMLElement $xml, int $limit): array
    {
        $groups = array_fill_keys(array_keys(self::GROUPS), []);
        foreach ($xml->services->service ?? [] as $service) {
            if (isset($service['alias'])) {
                continue;
            }
            $tags = [];
            foreach ($service->tag as $tag) {
                $tags[] = (string) $tag['name'];
            }
            foreach (self::GROUPS as $group => $tag) {
                if (in_array($tag, $tags, true)) {
                    $class = isset($service['class']) ? (string) $service['class'] : null;
                    $groups[$group][ltrim((string) $service['id'], '.')] = $class;
                }
            }
        }

        return array_map(static function (array $services) use ($limit): array {
            $count = count($services);
            $truncated = $limit > 0 && $count > $limit;

            return [
                'services' => $truncated ? array_slice($services, 0, $limit, true) : $services,
                'count' => $count,
                'truncated' => $truncated,
            ];
        }, $groups);
    }
}
