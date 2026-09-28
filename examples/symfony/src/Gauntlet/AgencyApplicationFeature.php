<?php

declare(strict_types=1);

namespace Gauntlet\SymfonyExample\Gauntlet;

use EightLines\Gauntlet\Core\Contract\FeatureProvider;
use EightLines\Gauntlet\Core\Definition\FeatureDefinition;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletFeature;

#[AsGauntletFeature]
final class AgencyApplicationFeature implements FeatureProvider
{
    public function definition(): FeatureDefinition
    {
        return new FeatureDefinition(
            id: 'agency-applications',
            label: 'Agency applications',
            order: 10,
        );
    }
}
