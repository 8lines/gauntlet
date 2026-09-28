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
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletDataSource;

#[AsGauntletDataSource]
final class UsersDataSource implements DataSource
{
    private ?DataSourceQuery $lastQuery = null;

    private ?DataSourceResolveRequest $lastResolveRequest = null;

    public function definition(): DataSourceDefinition
    {
        return new DataSourceDefinition(
            id: 'fixture.users',
            label: 'Fixture users',
            defaultLimit: 20,
            maxLimit: 100,
            dependencySchema: JsonOwnership::object([
                '$schema' => 'https://json-schema.org/draft/2020-12/schema',
                'type' => 'object',
                'required' => ['/agencyId'],
                'properties' => [
                    '/agencyId' => ['type' => 'string'],
                ],
                'additionalProperties' => false,
            ]),
            contextSchema: JsonOwnership::object([
                '$schema' => 'https://json-schema.org/draft/2020-12/schema',
                'type' => 'object',
                'required' => ['requestId'],
                'properties' => [
                    'requestId' => ['type' => 'string'],
                    'extensions' => ['type' => 'object'],
                ],
                'additionalProperties' => false,
            ]),
        );
    }

    public function query(DataSourceQuery $query): DataSourcePage
    {
        $this->lastQuery = $query;

        return new DataSourcePage([
            new DataSourceItem('user-1', 'Acme Insurance'),
        ]);
    }

    public function resolve(DataSourceResolveRequest $request): DataSourceResolveResponse
    {
        $this->lastResolveRequest = $request;

        return DataSourceResolveResponse::fromRequest(
            $request,
            static fn (string $value): ?DataSourceItem => $value === 'user-1'
                ? new DataSourceItem('user-1', 'Acme Insurance')
                : null,
        );
    }

    public function lastResolveRequest(): ?DataSourceResolveRequest
    {
        return $this->lastResolveRequest;
    }

    public function lastQuery(): ?DataSourceQuery
    {
        return $this->lastQuery;
    }
}
