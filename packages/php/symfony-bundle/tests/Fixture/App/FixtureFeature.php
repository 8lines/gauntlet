<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\Core\Contract\FeatureProvider;
use EightLines\Gauntlet\Core\Definition\FeatureDefinition;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletFeature;

#[AsGauntletFeature]
final class FixtureFeature implements FeatureProvider
{
    public function definition(): FeatureDefinition
    {
        return new FeatureDefinition('fixture', 'Fixture', order: 10);
    }
}
