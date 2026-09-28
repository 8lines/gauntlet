<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Registry;

use EightLines\Gauntlet\Core\Contract\DataSource;
use EightLines\Gauntlet\Core\DataSource\DataSourceItem;
use EightLines\Gauntlet\Core\DataSource\DataSourcePage;
use EightLines\Gauntlet\Core\DataSource\DataSourceQuery;
use EightLines\Gauntlet\Core\DataSource\DataSourceResolveRequest;
use EightLines\Gauntlet\Core\DataSource\DataSourceResolveResponse;
use EightLines\Gauntlet\Core\Definition\DataSourceDefinition;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Registry\DataSourceRegistry;
use PHPUnit\Framework\TestCase;

final class DataSourceRegistryTest extends TestCase
{
    public function testDuplicateKeepsTheFirstSourceAndDefinitionsAreSorted(): void
    {
        $first = new RegistryDataSource('same');
        $registry = new DataSourceRegistry([
            new RegistryDataSource('z-source'),
            $first,
            new RegistryDataSource('same'),
            new RegistryDataSource('a-source'),
        ]);

        self::assertSame($first, $registry->find('same'));
        self::assertSame('duplicate_data_source_id', $registry->diagnostics()[0]->code);
        self::assertSame(
            ['a-source', 'same', 'z-source'],
            array_map(static fn (DataSourceDefinition $definition): string => $definition->id, $registry->definitions()),
        );
    }

    public function testQueryAndResolvePreserveOwnedEnvelopesEmptyShapesAndExtensionsThroughDispatch(): void
    {
        $source = new RegistryDataSource('source');
        $registry = new DataSourceRegistry([$source]);
        $extensions = new ProtocolExtensions(JsonOwnership::object([
            'urn:test:extension' => ['enabled' => true],
        ]));
        $query = new DataSourceQuery(null, null, 20, JsonOwnership::object([]), extensions: $extensions);
        $queryWire = $registry->find('source')?->query($query)->toProtocolArray();

        self::assertSame('{}', json_encode($query->toProtocolArray()['dependencies'], JSON_THROW_ON_ERROR));
        self::assertEquals((object) ['enabled' => true], $query->extensions?->toProtocolArray()->{'urn:test:extension'});
        self::assertEquals((object) ['enabled' => true], $queryWire['extensions']->{'urn:test:extension'});

        $request = new DataSourceResolveRequest(['', 'known'], JsonOwnership::object([]), extensions: $extensions);
        $response = $registry->find('source')?->resolve($request);
        self::assertSame(['', 'known'], $request->toProtocolArray()['values']);
        self::assertSame(['', 'known'], array_column($response?->toProtocolArray()['results'] ?? [], 'value'));
        self::assertNull($response?->toProtocolArray()['results'][0]['item']);
        self::assertEquals(
            (object) ['enabled' => true],
            $response?->toProtocolArray()['extensions']->{'urn:test:extension'},
        );
        self::assertSame($extensions, $source->lastQuery?->extensions);
        self::assertSame($extensions, $source->lastResolve?->extensions);
    }

    public function testV1DefinitionRejectsNonCursorPaginationAndDisabledResolve(): void
    {
        foreach ([['none', true], ['cursor', false]] as [$pagination, $resolve]) {
            try {
                new DataSourceDefinition(
                    'source',
                    'Source',
                    pagination: $pagination,
                    resolve: $resolve,
                );
                self::fail('Expected invalid v1 data-source capabilities to be rejected.');
            } catch (\InvalidArgumentException) {
                self::addToAssertionCount(1);
            }
        }
    }
}

final class RegistryDataSource implements DataSource
{
    public ?DataSourceQuery $lastQuery = null;
    public ?DataSourceResolveRequest $lastResolve = null;

    public function __construct(private readonly string $id)
    {
    }

    public function definition(): DataSourceDefinition
    {
        return new DataSourceDefinition($this->id, 'Source');
    }

    public function query(DataSourceQuery $query): DataSourcePage
    {
        $this->lastQuery = $query;

        return new DataSourcePage([], extensions: $query->extensions);
    }

    public function resolve(DataSourceResolveRequest $request): DataSourceResolveResponse
    {
        $this->lastResolve = $request;

        return new DataSourceResolveResponse([
            ['value' => '', 'item' => null],
            ['value' => 'known', 'item' => new DataSourceItem('known', 'Known')],
        ], $request->extensions);
    }
}
