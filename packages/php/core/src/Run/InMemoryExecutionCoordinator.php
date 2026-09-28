<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

use EightLines\Gauntlet\Core\Contract\ExecutionCoordinator;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;

/** Process-local coordinator for tests and single-process development. */
final class InMemoryExecutionCoordinator implements ExecutionCoordinator
{
    /** @var array<string, array{operationId: string, policy: string, fingerprint: ?string, published: bool}> */
    private array $registrations = [];

    /** @var array<string, list<string>> */
    private array $operationOrder = [];

    /** @var array<string, array<string, string>> */
    private array $fingerprints = [];

    /** @var array<string, array<string, true>> */
    private array $active = [];

    /** @var array<string, true> */
    private array $cancelled = [];

    /** @var array<string, list<\Fiber>> */
    private array $turnWaiters = [];

    /** @var array<string, list<\Fiber>> */
    private array $publicationWaiters = [];

    public function register(
        string $operationId,
        string $runId,
        string $concurrency,
        ?string $idempotencyFingerprint,
    ): ExecutionRegistration {
        ProtocolId::assert($operationId);
        ProtocolId::assert($runId);
        if (!in_array($concurrency, ['allow', 'forbid', 'queue'], true)) {
            throw new \InvalidArgumentException('Invalid concurrency policy.');
        }
        if (isset($this->registrations[$runId])) {
            throw new \LogicException('Execution run ID is already registered.');
        }

        while ($idempotencyFingerprint !== null
            && isset($this->fingerprints[$operationId][$idempotencyFingerprint])) {
            $winner = $this->fingerprints[$operationId][$idempotencyFingerprint];
            if (($this->registrations[$winner]['published'] ?? false) === true) {
                return ExecutionRegistration::duplicate($winner);
            }
            $fiber = \Fiber::getCurrent();
            if ($fiber === null) {
                throw new \RuntimeException(
                    'Cannot resolve an idempotency replay before publication outside a Fiber.',
                );
            }
            $this->publicationWaiters[$winner][] = $fiber;
            \Fiber::suspend();
        }

        if ($concurrency === 'forbid') {
            while (($existing = $this->operationOrder[$operationId] ?? []) !== []) {
                foreach ($existing as $blocker) {
                    if (($this->registrations[$blocker]['published'] ?? false) === true) {
                        return ExecutionRegistration::rejected();
                    }
                }
                $blocker = $existing[0];
                $fiber = \Fiber::getCurrent();
                if ($fiber === null) {
                    throw new \RuntimeException(
                        'Cannot resolve an execution admission conflict before publication outside a Fiber.',
                    );
                }
                $this->publicationWaiters[$blocker][] = $fiber;
                \Fiber::suspend();
            }
        }

        $existing = $this->operationOrder[$operationId] ?? [];

        $this->registrations[$runId] = [
            'operationId' => $operationId,
            'policy' => $concurrency,
            'fingerprint' => $idempotencyFingerprint,
            'published' => false,
        ];
        $this->operationOrder[$operationId][] = $runId;
        if ($idempotencyFingerprint !== null) {
            $this->fingerprints[$operationId][$idempotencyFingerprint] = $runId;
        }

        return $concurrency === 'queue' && $existing !== []
            ? ExecutionRegistration::queued()
            : ExecutionRegistration::ready();
    }

    public function publish(string $runId): void
    {
        if (!isset($this->registrations[$runId])) {
            throw new \LogicException('Cannot publish an unknown execution registration.');
        }
        $this->registrations[$runId]['published'] = true;
        $this->resumeAll($this->publicationWaiters[$runId] ?? []);
        unset($this->publicationWaiters[$runId]);
    }

    public function abort(string $runId): void
    {
        $operationId = $this->remove($runId);
        if ($operationId !== null) {
            $this->wakeNext($operationId);
        }
    }

    public function awaitTurn(string $operationId, string $runId): ?bool
    {
        while (isset($this->registrations[$runId])) {
            if (isset($this->cancelled[$runId])) {
                return false;
            }
            $registration = $this->registrations[$runId];
            if ($registration['operationId'] !== $operationId || !$registration['published']) {
                throw new \LogicException('Execution registration is not ready to run.');
            }
            if ($registration['policy'] !== 'queue'
                || (($this->operationOrder[$operationId][0] ?? null) === $runId
                    && ($this->active[$operationId] ?? []) === [])) {
                $this->active[$operationId][$runId] = true;

                return true;
            }
            $fiber = \Fiber::getCurrent();
            if ($fiber === null) {
                return null;
            }
            $this->turnWaiters[$runId][] = $fiber;
            \Fiber::suspend();
        }

        return false;
    }

    public function release(string $operationId, string $runId): void
    {
        unset($this->active[$operationId][$runId]);
        if (($this->active[$operationId] ?? []) === []) {
            unset($this->active[$operationId]);
        }
        $this->remove($runId);
        $this->wakeNext($operationId);
    }

    public function requestCancellation(string $runId): void
    {
        ProtocolId::assert($runId);
        $this->cancelled[$runId] = true;
        $registration = $this->registrations[$runId] ?? null;
        if ($registration === null) {
            return;
        }
        if (!isset($this->active[$registration['operationId']][$runId])) {
            $operationId = $registration['operationId'];
            $this->remove($runId, clearCancellation: false);
            $this->resumeAll($this->turnWaiters[$runId] ?? []);
            unset($this->turnWaiters[$runId]);
            $this->wakeNext($operationId);
        }
    }

    public function isCancellationRequested(string $runId): bool
    {
        return isset($this->cancelled[$runId]);
    }

    private function remove(string $runId, bool $clearCancellation = true): ?string
    {
        $registration = $this->registrations[$runId] ?? null;
        if ($registration === null) {
            if ($clearCancellation) {
                unset($this->cancelled[$runId]);
            }

            return null;
        }
        unset($this->registrations[$runId]);
        $operationId = $registration['operationId'];
        $this->operationOrder[$operationId] = array_values(array_filter(
            $this->operationOrder[$operationId] ?? [],
            static fn (string $candidate): bool => $candidate !== $runId,
        ));
        if ($this->operationOrder[$operationId] === []) {
            unset($this->operationOrder[$operationId]);
        }
        if ($registration['fingerprint'] !== null
            && ($this->fingerprints[$operationId][$registration['fingerprint']] ?? null) === $runId) {
            unset($this->fingerprints[$operationId][$registration['fingerprint']]);
        }
        if ($clearCancellation) {
            unset($this->cancelled[$runId]);
        }
        $this->resumeAll($this->publicationWaiters[$runId] ?? []);
        unset($this->publicationWaiters[$runId]);

        return $operationId;
    }

    private function wakeNext(string $operationId): void
    {
        $next = $this->operationOrder[$operationId][0] ?? null;
        if ($next !== null) {
            $this->resumeAll($this->turnWaiters[$next] ?? []);
            unset($this->turnWaiters[$next]);
        }
    }

    /** @param list<\Fiber> $fibers */
    private function resumeAll(array $fibers): void
    {
        foreach ($fibers as $fiber) {
            if ($fiber->isSuspended()) {
                $fiber->resume();
            }
        }
    }
}
