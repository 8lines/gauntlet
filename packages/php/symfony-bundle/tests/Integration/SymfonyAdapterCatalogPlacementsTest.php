<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Integration;

use EightLines\Gauntlet\Core\Contract\FeatureProvider;
use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Definition\ExecutionPolicy;
use EightLines\Gauntlet\Core\Definition\FeatureDefinition;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Definition\OperationOutput;
use EightLines\Gauntlet\Core\Definition\OperationPlacement;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\Core\Schema\PlacementRules;
use EightLines\Gauntlet\SymfonyBundle\Capability\CapabilityRegistry;
use EightLines\Gauntlet\SymfonyBundle\Http\ProblemSanitizer;
use EightLines\Gauntlet\SymfonyBundle\Registry\SymfonyAdapterCatalog;
use EightLines\Gauntlet\SymfonyBundle\Registry\SymfonyDataSourceRegistry;
use EightLines\Gauntlet\SymfonyBundle\Registry\SymfonyFeatureRegistry;
use EightLines\Gauntlet\SymfonyBundle\Registry\SymfonyOperationRegistry;
use EightLines\Gauntlet\SymfonyBundle\Support\AdapterConfiguration;
use PHPUnit\Framework\TestCase;

final class SymfonyAdapterCatalogPlacementsTest extends TestCase
{
    public function testProfilesKeepTheirSortedPreBranchShapeWithoutPlacements(): void
    {
        $manifest = self::catalog(['tc-schema-core@1', 'tc-rich-forms@1'], [])->manifest()->toProtocolArray();

        self::assertSame(['tc-rich-forms@1', 'tc-schema-core@1'], $manifest['profiles']);
    }

    public function testPlacementsAdvertiseTheProfileExactlyOnce(): void
    {
        $placements = [
            OperationPlacement::global(),
            OperationPlacement::subject('order', ['/orderId' => 'orderId']),
        ];
        foreach ([['tc-schema-core@1'], ['tc-schema-core@1', PlacementRules::PROFILE]] as $configured) {
            $catalog = self::catalog($configured, $placements);
            $manifest = $catalog->manifest()->toProtocolArray();

            self::assertSame([PlacementRules::PROFILE, 'tc-schema-core@1'], $manifest['profiles']);
            $expected = [
                ['kind' => 'global'],
                ['kind' => 'subject', 'subjectType' => 'order', 'bindings' => ['/orderId' => 'orderId']],
            ];
            self::assertSame($expected, $manifest['operations'][0]['placements']);
            self::assertSame($expected, $catalog->operationDefinition('orders.pay')?->toProtocolArray()['placements']);
        }
    }

    /**
     * @param list<string> $profiles
     * @param list<OperationPlacement> $placements
     */
    private static function catalog(array $profiles, array $placements): SymfonyAdapterCatalog
    {
        $feature = new class implements FeatureProvider {
            public function definition(): FeatureDefinition
            {
                return new FeatureDefinition('orders', 'Orders');
            }
        };
        $operation = new class ($placements) implements OperationHandler {
            /** @param list<OperationPlacement> $placements */
            public function __construct(private readonly array $placements)
            {
            }

            public function definition(): OperationDefinition
            {
                return new OperationDefinition(
                    id: 'orders.pay',
                    featureId: 'orders',
                    label: 'Pay',
                    description: null,
                    inputSchema: JsonOwnership::object([
                        '$schema' => 'https://json-schema.org/draft/2020-12/schema',
                        'type' => 'object',
                        'properties' => ['orderId' => ['type' => 'string']],
                        'additionalProperties' => false,
                    ]),
                    inputHandling: null,
                    contextSchema: null,
                    uiSchema: null,
                    dataSources: [],
                    presets: [],
                    execution: new ExecutionPolicy(OperationImpact::READ, false, false, 'optional', false),
                    output: new OperationOutput(JsonOwnership::object([
                        '$schema' => 'https://json-schema.org/draft/2020-12/schema',
                        'type' => 'object',
                    ])),
                    placements: $this->placements,
                );
            }

            public function execute(object $input, RunContext $context): OperationResult
            {
                return new OperationResult(JsonOwnership::object([]));
            }
        };

        return new SymfonyAdapterCatalog(
            new AdapterConfiguration(
                enabled: true,
                applicationId: 'fixture',
                applicationLabel: 'Fixture',
                environmentName: 'fixture-test',
                environmentKind: 'test',
                profiles: $profiles,
                idempotencySecret: str_repeat('s', 32),
            ),
            new SymfonyFeatureRegistry([$feature]),
            new SymfonyOperationRegistry([$operation]),
            new SymfonyDataSourceRegistry([]),
            new CapabilityRegistry([], [], [], [], []),
            new ProblemSanitizer(),
        );
    }
}
