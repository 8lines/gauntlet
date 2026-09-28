<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Http;

use EightLines\Gauntlet\Core\DataSource\DataSourcePage;
use EightLines\Gauntlet\Core\DataSource\DataSourceResolveRequest;
use EightLines\Gauntlet\Core\DataSource\DataSourceResolveResponse;
use EightLines\Gauntlet\Core\Definition\DataSourceDefinition;
use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Schema\ProtocolSemantics;

final class DataSourceResponseValidator
{
    public function page(DataSourcePage $page, DataSourceDefinition $definition): JsonObject
    {
        $wire = JsonOwnership::object($page->toProtocolArray());
        if ($definition->pagination === 'none' && $wire->has('nextCursor')) {
            throw new \UnexpectedValueException('A non-paginated data source returned a cursor.');
        }

        return $wire;
    }

    public function resolve(
        DataSourceResolveRequest $request,
        DataSourceResolveResponse $response,
    ): JsonObject {
        $wire = JsonOwnership::object($response->toProtocolArray());
        $transport = JsonOwnership::transport($wire);
        if (
            !$transport instanceof \stdClass
            || !is_array($transport->results ?? null)
            || !ProtocolSemantics::resolveSemanticsAreValid($request->values, $transport->results)
        ) {
            throw new \UnexpectedValueException('Invalid data source resolve response.');
        }

        return $wire;
    }
}
