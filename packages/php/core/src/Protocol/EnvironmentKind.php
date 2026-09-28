<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Protocol;

enum EnvironmentKind: string
{
    case Development = 'development';
    case Test = 'test';
    case Qa = 'qa';
    case Staging = 'staging';
    case Uat = 'uat';
    case Preview = 'preview';
    case Sandbox = 'sandbox';
}
