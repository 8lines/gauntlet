<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\DependencyInjection;

use EightLines\Gauntlet\Core\Protocol\EnvironmentDescriptor;
use Symfony\Component\Config\Definition\Builder\TreeBuilder;
use Symfony\Component\Config\Definition\ConfigurationInterface;
use Symfony\Component\Config\Definition\Exception\InvalidConfigurationException;

final class Configuration implements ConfigurationInterface
{
    public function getConfigTreeBuilder(): TreeBuilder
    {
        $treeBuilder = new TreeBuilder('gauntlet');
        $root = $treeBuilder->getRootNode();
        $root
            ->children()
                ->booleanNode('enabled')->defaultFalse()->end()
                ->arrayNode('application')
                    ->addDefaultsIfNotSet()
                    ->children()
                        ->scalarNode('id')->defaultNull()->end()
                        ->scalarNode('label')->defaultNull()->end()
                        ->variableNode('environment')->end()
                    ->end()
                ->end()
                ->arrayNode('profiles')
                    ->scalarPrototype()->end()
                    ->defaultValue([])
                ->end()
                ->scalarNode('idempotency_secret')
                    ->cannotBeEmpty()
                    ->defaultValue('')
                ->end()
                ->integerNode('max_json_bytes')
                    ->min(1)
                    ->defaultValue(1_048_576)
                ->end()
            ->end()
            ->validate()
                ->ifTrue(static function (array $value): bool {
                    $environment = $value['application']['environment'] ?? null;
                    if ($environment === null) {
                        return ($value['enabled'] ?? false) === true;
                    }

                    try {
                        EnvironmentDescriptor::fromProtocolValue($environment);

                        return false;
                    } catch (\InvalidArgumentException) {
                        return true;
                    }
                })
                ->then(static fn (): never => throw self::invalidEnvironmentConfiguration())
            ->end()
            ->validate()
                ->ifTrue(static function (array $value): bool {
                    if (($value['enabled'] ?? false) !== true) {
                        return false;
                    }

                    $application = $value['application'] ?? [];

                    return !is_string($application['id'] ?? null)
                        || trim((string) $application['id']) === ''
                        || !is_string($application['label'] ?? null)
                        || trim((string) $application['label']) === '';
                })
                ->thenInvalid('Enabled Gauntlet adapter requires application.id and application.label.')
            ->end()
            ->validate()
                ->ifTrue(static function (array $value): bool {
                    if (($value['enabled'] ?? false) !== true) {
                        return false;
                    }
                    $secret = $value['idempotency_secret'] ?? '';

                    return !is_string($secret)
                        || strlen($secret) < 32;
                })
                ->thenInvalid(
                    'Enabled Gauntlet adapter requires an explicit stable idempotency_secret of at least 32 bytes.',
                )
            ->end();

        return $treeBuilder;
    }

    private static function invalidEnvironmentConfiguration(): InvalidConfigurationException
    {
        $exception = new InvalidConfigurationException(
            'Invalid configuration for path "gauntlet.application.environment": '
                . 'Enabled Gauntlet adapter requires a valid non-production application.environment.',
        );
        $exception->setPath('gauntlet.application.environment');

        return $exception;
    }
}
