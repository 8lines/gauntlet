<?php

declare(strict_types=1);

use EightLines\Gauntlet\SymfonyBundle\GauntletBundle;
use Symfony\Bundle\FrameworkBundle\FrameworkBundle;

return [
    FrameworkBundle::class => ['all' => true],
    GauntletBundle::class => ['all' => true],
];
