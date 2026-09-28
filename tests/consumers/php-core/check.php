<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use EightLines\Gauntlet\Core\Protocol\EnvironmentDescriptor;
use EightLines\Gauntlet\Core\Protocol\EnvironmentKind;

$environment = new EnvironmentDescriptor('consumer-test', EnvironmentKind::Test);
if ($environment->toProtocolArray() !== ['name' => 'consumer-test', 'kind' => 'test']) {
    throw new RuntimeException('Core package consumer check failed.');
}
