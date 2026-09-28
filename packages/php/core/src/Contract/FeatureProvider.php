<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Contract;

use EightLines\Gauntlet\Core\Definition\FeatureDefinition;

interface FeatureProvider
{
    public const TAG = 'gauntlet.feature';

    public function definition(): FeatureDefinition;
}
