<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use EightLines\Gauntlet\SymfonyBundle\Http\StreamConnection;

final class DisconnectingStreamConnection implements StreamConnection
{
    public int $checks = 0;

    public int $flushes = 0;

    public int $disconnectAfterChecks = 2;

    public function disconnected(): bool
    {
        return ++$this->checks > $this->disconnectAfterChecks;
    }

    public function flush(): void
    {
        ++$this->flushes;
    }
}
