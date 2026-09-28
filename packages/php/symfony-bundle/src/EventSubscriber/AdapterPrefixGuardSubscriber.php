<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\EventSubscriber;

use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\SymfonyBundle\Http\ProblemResponseFactory;
use EightLines\Gauntlet\SymfonyBundle\Http\RawAdapterTargetGuard;
use EightLines\Gauntlet\SymfonyBundle\Support\AdapterEnabledGate;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\KernelEvents;

final readonly class AdapterPrefixGuardSubscriber implements EventSubscriberInterface
{
    public function __construct(
        private AdapterEnabledGate $enabledGate,
        private RawAdapterTargetGuard $targetGuard,
        private ProblemResponseFactory $problems,
    ) {
    }

    public function onKernelRequest(RequestEvent $event): void
    {
        $request = $event->getRequest();
        $rawTarget = $request->server->get('UNENCODED_URL');
        if (!is_string($rawTarget) || $rawTarget === '') {
            $rawTarget = $request->server->get('REQUEST_URI');
        }
        if (!is_string($rawTarget) || $rawTarget === '') {
            $rawTarget = $request->getRequestUri();
        }

        $normalizedPath = $request->getPathInfo();
        if (!$this->targetGuard->requestTargetsAdapter($rawTarget, $normalizedPath)) {
            return;
        }
        if (!$this->enabledGate->isEnabled()) {
            $event->setResponse($this->problems->create(new Problem(
                type: 'urn:gauntlet:problem:adapter-disabled',
                title: 'Gauntlet adapter is disabled',
                status: 503,
            )));

            return;
        }

        $problem = $this->targetGuard->inspectRequest(
            $rawTarget,
            $normalizedPath,
            $request->getMethod(),
        );
        if ($problem !== null) {
            $event->setResponse($this->problems->create($problem));
        }
    }

    public static function getSubscribedEvents(): array
    {
        return [KernelEvents::REQUEST => ['onKernelRequest', 512]];
    }
}
