<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Contract\DataSource;
use EightLines\Gauntlet\Core\DataSource\DataSourcePage;
use EightLines\Gauntlet\Core\DataSource\DataSourceQuery;
use EightLines\Gauntlet\Core\DataSource\DataSourceResolveRequest;
use EightLines\Gauntlet\Core\DataSource\DataSourceResolveResponse;
use EightLines\Gauntlet\Core\Definition\DataSourceDefinition;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletDataSource;

#[AsGauntletDataSource]
final class RestrictedDataSource implements DataSource
{
    public int $queryInvocations = 0;

    public int $resolveInvocations = 0;

    public function definition(): DataSourceDefinition
    {
        return new DataSourceDefinition(
            id: 'fixture.restricted',
            label: 'Restricted fixture source',
            search: false,
            pagination: 'none',
            resolve: false,
        );
    }

    public function query(DataSourceQuery $query): DataSourcePage
    {
        ++$this->queryInvocations;

        return new DataSourcePage([]);
    }

    public function resolve(DataSourceResolveRequest $request): DataSourceResolveResponse
    {
        ++$this->resolveInvocations;

        return new DataSourceResolveResponse([]);
    }
}
