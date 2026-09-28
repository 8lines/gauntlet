<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Contract;

use EightLines\Gauntlet\Core\DataSource\DataSourcePage;
use EightLines\Gauntlet\Core\DataSource\DataSourceQuery;
use EightLines\Gauntlet\Core\DataSource\DataSourceResolveRequest;
use EightLines\Gauntlet\Core\DataSource\DataSourceResolveResponse;
use EightLines\Gauntlet\Core\Definition\DataSourceDefinition;

interface DataSource
{
    public const TAG = 'gauntlet.data_source';

    public function definition(): DataSourceDefinition;

    public function query(DataSourceQuery $query): DataSourcePage;

    public function resolve(DataSourceResolveRequest $request): DataSourceResolveResponse;
}
