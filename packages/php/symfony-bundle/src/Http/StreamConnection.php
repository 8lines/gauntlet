<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Http;

interface StreamConnection
{
    public function disconnected(): bool;

    public function flush(): void;
}
