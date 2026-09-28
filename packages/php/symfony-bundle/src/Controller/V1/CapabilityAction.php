<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Controller\V1;

use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\SymfonyBundle\Capability\CancelRunEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Capability\CapabilityRegistry;
use EightLines\Gauntlet\SymfonyBundle\Capability\RunEventsEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Capability\SessionLaunchEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Capability\UploadEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Http\CapabilityResponseValidator;
use EightLines\Gauntlet\SymfonyBundle\Http\ProblemResponseFactory;
use EightLines\Gauntlet\SymfonyBundle\Http\ProtocolResponseFactory;
use EightLines\Gauntlet\SymfonyBundle\Http\RunEventStream;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;

final readonly class CapabilityAction
{
    public function __construct(
        private CapabilityRegistry $capabilities,
        private UnsupportedCapabilityAction $unsupported,
        private CapabilityResponseValidator $responseValidator,
        private ProtocolResponseFactory $responses,
        private ProblemResponseFactory $problems,
        private RunEventStream $eventStream,
    ) {
    }

    public function __invoke(
        Request $request,
        string $capability,
        ?string $runId = null,
        ?string $artifactId = null,
    ): Response {
        $endpoint = $this->capabilities->endpoint($capability);
        if ($endpoint === null) {
            return ($this->unsupported)($capability);
        }

        try {
            return match ($capability) {
                'tc-run-cancellation@1' => $this->cancel($endpoint, $runId),
                'tc-run-sse@1' => $this->events($endpoint, $request, $runId),
                'tc-uploads@1' => $this->upload($endpoint, $request),
                'tc-session-launch@1' => $this->launch($endpoint, $runId, $artifactId),
                default => ($this->unsupported)($capability),
            };
        } catch (\Throwable) {
            return $this->problems->internal('Capability request failed');
        }
    }

    private function cancel(object $endpoint, ?string $runId): Response
    {
        if (!$endpoint instanceof CancelRunEndpoint || $runId === null) {
            throw new \LogicException('Capability registry returned the wrong endpoint.');
        }
        $result = $endpoint->cancel($runId);

        return $result instanceof Problem
            ? $this->problems->create($result, expectedCapability: 'tc-run-cancellation@1')
            : $this->responses->json($this->responseValidator->run($result, $runId), 202);
    }

    private function events(object $endpoint, Request $request, ?string $runId): Response
    {
        if (!$endpoint instanceof RunEventsEndpoint || $runId === null) {
            throw new \LogicException('Capability registry returned the wrong endpoint.');
        }
        $lastEventId = $request->headers->get('Last-Event-ID');
        if ($lastEventId !== null
            && preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/D', $lastEventId) !== 1) {
            return $this->problems->create(Problem::validation([]));
        }
        $events = $endpoint->events($runId, $lastEventId);
        if ($events instanceof Problem) {
            return $this->problems->create($events, expectedCapability: 'tc-run-sse@1');
        }

        return $this->eventStream->create($events, $runId);
    }

    private function upload(object $endpoint, Request $request): Response
    {
        if (!$endpoint instanceof UploadEndpoint) {
            throw new \LogicException('Capability registry returned the wrong endpoint.');
        }
        $file = $request->files->get('file');
        if (!$file instanceof \Symfony\Component\HttpFoundation\File\UploadedFile) {
            return $this->problems->create(Problem::validation([]));
        }
        $result = $endpoint->upload($file);

        return $result instanceof Problem
            ? $this->problems->create($result, expectedCapability: 'tc-uploads@1')
            : $this->responses->json($this->responseValidator->upload($result), 201);
    }

    private function launch(object $endpoint, ?string $runId, ?string $artifactId): Response
    {
        if (!$endpoint instanceof SessionLaunchEndpoint || $runId === null || $artifactId === null) {
            throw new \LogicException('Capability registry returned the wrong endpoint.');
        }
        $result = $endpoint->launch($runId, $artifactId);

        return $result instanceof Problem
            ? $this->problems->create($result, expectedCapability: 'tc-session-launch@1')
            : $this->responses->json($this->responseValidator->session($result), 201);
    }
}
