<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Controller\V1;

use EightLines\Gauntlet\SymfonyBundle\Http\ProtocolResponseFactory;
use EightLines\Gauntlet\SymfonyBundle\Registry\SymfonyAdapterCatalog;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;

final readonly class ManifestAction
{
    public function __construct(
        private SymfonyAdapterCatalog $catalog,
        private ProtocolResponseFactory $responses,
    ) {
    }

    public function __invoke(Request $request): Response
    {
        $manifest = $this->catalog->manifest();

        return $this->responses->json($manifest, revision: $manifest->revision(), request: $request);
    }
}
