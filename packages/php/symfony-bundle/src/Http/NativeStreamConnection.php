<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Http;

final class NativeStreamConnection implements StreamConnection
{
    public function disconnected(): bool
    {
        return connection_aborted() !== 0;
    }

    public function flush(): void
    {
        if (PHP_SAPI !== 'cli') {
            @ob_flush();
        }
        flush();
    }
}
