<?php

declare(strict_types=1);

namespace Gauntlet\SymfonyExample\Gauntlet;

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
final class PendingApplicationsDataSource implements DataSource
{
    /** @var list<array{value: string, label: string, description: string}> */
    private const APPLICATIONS = [
        [
            'value' => '11111111-1111-4111-8111-111111111111',
            'label' => 'Alice Brown',
            'description' => 'Pending application APP-001',
        ],
        [
            'value' => '22222222-2222-4222-8222-222222222222',
            'label' => 'Blue Insurance',
            'description' => 'Pending application APP-002',
        ],
        [
            'value' => '',
            'label' => 'Unassigned application',
            'description' => 'Proves that an empty-string value remains transport-safe.',
        ],
    ];

    public function definition(): DataSourceDefinition
    {
        return new DataSourceDefinition(
            id: 'pending-applications',
            label: 'Pending applications',
            defaultLimit: 20,
            maxLimit: 100,
            description: 'Searchable synthetic pending agency applications.',
            dependencySchema: JsonOwnership::object([
                '$schema' => 'https://json-schema.org/draft/2020-12/schema',
                'type' => 'object',
                'required' => ['/workflowState'],
                'properties' => [
                    '/workflowState' => ['const' => 'pending'],
                ],
                'additionalProperties' => false,
            ]),
            contextSchema: JsonOwnership::object([
                '$schema' => 'https://json-schema.org/draft/2020-12/schema',
                'type' => 'object',
                'required' => ['requestId', 'target'],
                'properties' => [
                    'requestId' => ['type' => 'string', 'minLength' => 1],
                    'target' => [
                        'type' => 'object',
                        'required' => ['id', 'environment'],
                        'properties' => [
                            'id' => ['type' => 'string', 'minLength' => 1],
                            'environment' => ['type' => 'string', 'minLength' => 1],
                        ],
                        'additionalProperties' => false,
                    ],
                ],
                'additionalProperties' => false,
            ]),
        );
    }

    public function query(DataSourceQuery $query): DataSourcePage
    {
        $workflowState = $query->dependencies->values()['/workflowState'] ?? null;
        if ($workflowState !== 'pending') {
            return new DataSourcePage([]);
        }

        $applications = array_values(array_filter(
            self::APPLICATIONS,
            static fn (array $application): bool => $query->search === null
                || mb_stripos($application['label'], $query->search) !== false,
        ));
        $offset = $this->cursorOffset($query->cursor);
        $limit = min($query->limit ?? 20, 100);
        $page = array_slice($applications, $offset, $limit);
        $nextOffset = $offset + count($page);

        return new DataSourcePage(
            items: array_map(self::item(...), $page),
            nextCursor: $nextOffset < count($applications) ? (string) $nextOffset : null,
        );
    }

    public function resolve(DataSourceResolveRequest $request): DataSourceResolveResponse
    {
        if (($request->dependencies->values()['/workflowState'] ?? null) !== 'pending') {
            return DataSourceResolveResponse::fromRequest($request, static fn (): null => null);
        }

        return DataSourceResolveResponse::fromRequest($request, function (string $value): ?DataSourceItem {
            foreach (self::APPLICATIONS as $application) {
                if ($application['value'] === $value) {
                    return self::item($application);
                }
            }

            return null;
        });
    }

    private function cursorOffset(?string $cursor): int
    {
        if ($cursor === null) {
            return 0;
        }
        if ($cursor === '' || !ctype_digit($cursor)) {
            throw new \InvalidArgumentException('Invalid cursor.');
        }

        return (int) $cursor;
    }

    /** @param array{value: string, label: string, description: string} $application */
    private static function item(array $application): DataSourceItem
    {
        return new DataSourceItem(
            value: $application['value'],
            label: $application['label'],
            description: $application['description'],
        );
    }
}
