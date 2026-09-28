<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Contract\DataSource;
use EightLines\Gauntlet\Core\DataSource\DataSourceItem;
use EightLines\Gauntlet\Core\DataSource\DataSourcePage;
use EightLines\Gauntlet\Core\DataSource\DataSourceQuery;
use EightLines\Gauntlet\Core\DataSource\DataSourceResolveRequest;
use EightLines\Gauntlet\Core\DataSource\DataSourceResolveResponse;
use EightLines\Gauntlet\Core\Definition\DataSourceDefinition;
use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletDataSource;

#[AsGauntletDataSource]
final class HostileDataSource implements DataSource
{
    public int $queryInvocations = 0;

    public int $resolveInvocations = 0;

    public function definition(): DataSourceDefinition
    {
        return new DataSourceDefinition(
            id: 'fixture.hostile',
            label: 'Hostile fixture source',
        );
    }

    public function query(DataSourceQuery $query): DataSourcePage
    {
        ++$this->queryInvocations;

        return match ($query->search) {
            'invalid-shape' => $this->invalidPageShape(),
            'invalid-scalar' => new DataSourcePage([
                new DataSourceItem(
                    value: 'unsafe',
                    label: 'Unsafe scalar',
                    metadata: new JsonObject(['notFinite' => NAN]),
                ),
            ]),
            default => new DataSourcePage([]),
        };
    }

    public function resolve(DataSourceResolveRequest $request): DataSourceResolveResponse
    {
        ++$this->resolveInvocations;

        if ($request->values === ['invalid-scalar']) {
            return new DataSourceResolveResponse([[
                'value' => 'invalid-scalar',
                'item' => new DataSourceItem(
                    value: 'invalid-scalar',
                    label: 'Unsafe scalar',
                    metadata: new JsonObject(['notFinite' => NAN]),
                ),
            ]]);
        }
        if ($request->values === ['invalid-shape']) {
            return $this->invalidResolveShape();
        }

        return new DataSourceResolveResponse([['value' => 'different-value', 'item' => null]]);
    }

    private function invalidPageShape(): DataSourcePage
    {
        $reflection = new \ReflectionClass(DataSourcePage::class);
        /** @var DataSourcePage $page */
        $page = $reflection->newInstanceWithoutConstructor();
        $reflection->getProperty('items')->setValue($page, ['not-a-data-source-item']);
        $reflection->getProperty('nextCursor')->setValue($page, null);

        return $page;
    }

    private function invalidResolveShape(): DataSourceResolveResponse
    {
        $reflection = new \ReflectionClass(DataSourceResolveResponse::class);
        /** @var DataSourceResolveResponse $response */
        $response = $reflection->newInstanceWithoutConstructor();
        $reflection->getProperty('results')->setValue($response, [[
            'value' => 'invalid-shape',
            'item' => 'not-a-data-source-item',
        ]]);

        return $response;
    }
}
