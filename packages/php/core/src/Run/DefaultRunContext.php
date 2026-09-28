<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Result\Artifact;

final class DefaultRunContext implements RunContext
{
    /** @var list<Artifact> */
    private array $artifacts = [];

    /** @var list<FollowUpAction> */
    private array $actions = [];

    private ?RunProgress $latestProgress = null;

    private bool $open = true;

    private ?RunStatus $terminationStatus = null;

    /** @var (\Closure(): bool)|null */
    private ?\Closure $cancellationRequested;

    /**
     * @var list<array{
     *     kind: 'progress'|'artifact'|'action',
     *     timestamp: string,
     *     value: RunProgress|Artifact|FollowUpAction
     * }>
     */
    private array $events = [];

    public function __construct(
        private readonly string $runId,
        private readonly string $operationId,
        private readonly bool $dryRun,
        private readonly InvocationContextLease $lease,
        ?\Closure $cancellationRequested = null,
        private readonly ?int $deadlineNanoseconds = null,
    ) {
        $this->cancellationRequested = $cancellationRequested;
    }

    public function runId(): string
    {
        return $this->runId;
    }

    public function operationId(): string
    {
        return $this->operationId;
    }

    public function isDryRun(): bool
    {
        return $this->dryRun;
    }

    public function invocationContext(): ?InvocationContext
    {
        return $this->lease->get();
    }

    public function isCancelled(): bool
    {
        if ($this->terminationStatus !== null) {
            return true;
        }
        if (!$this->open) {
            return false;
        }
        if ($this->deadlineNanoseconds !== null && hrtime(true) >= $this->deadlineNanoseconds) {
            $this->terminationStatus = RunStatus::TIMED_OUT;

            return true;
        }
        try {
            if (($this->cancellationRequested !== null) && ($this->cancellationRequested)()) {
                $this->terminationStatus = RunStatus::CANCELLED;

                return true;
            }
        } catch (\Throwable) {
            // A broken cancellation backend must fail closed before another
            // handler side effect is emitted.
            $this->terminationStatus = RunStatus::CANCELLED;

            return true;
        }

        return false;
    }

    public function progress(int|float|null $current, int|float|null $total, ?string $message = null): void
    {
        if (!$this->open || $this->isCancelled()) {
            return;
        }
        $timestamp = self::now();
        $progress = new RunProgress($current, $total, $message, $timestamp);
        $this->latestProgress = $progress;
        $this->events[] = ['kind' => 'progress', 'timestamp' => $timestamp, 'value' => $progress];
    }

    public function artifact(Artifact $artifact): void
    {
        if (!$this->open || $this->isCancelled()) {
            return;
        }
        $this->artifacts[] = $artifact;
        $this->events[] = ['kind' => 'artifact', 'timestamp' => self::now(), 'value' => $artifact];
    }

    public function action(FollowUpAction $action): void
    {
        if (!$this->open || $this->isCancelled()) {
            return;
        }
        $this->actions[] = $action;
        $this->events[] = ['kind' => 'action', 'timestamp' => self::now(), 'value' => $action];
    }

    public function log(string $level, string $message, ?JsonObject $context = null): void
    {
        if (!$this->open || $this->isCancelled()) {
            return;
        }
        if (!in_array($level, ['debug', 'info', 'warning', 'error'], true)) {
            throw new \InvalidArgumentException('Invalid structured log level.');
        }
        $entry = ['level' => $level, 'message' => $message];
        if ($context !== null) {
            $entry['context'] = $context;
        }
        $this->artifact(new Artifact(
            'log-' . bin2hex(random_bytes(12)),
            'urn:gauntlet:artifact:structured-log',
            \EightLines\Gauntlet\Core\Json\JsonOwnership::object([
                'data' => ['entries' => [$entry]],
            ]),
        ));
    }

    public function warning(string $message): void
    {
        if (!$this->open || $this->isCancelled()) {
            return;
        }
        $this->artifact(new Artifact(
            'warning-' . bin2hex(random_bytes(12)),
            'notice',
            \EightLines\Gauntlet\Core\Json\JsonOwnership::object([
                'level' => 'warning',
                'message' => $message,
            ]),
        ));
    }

    /** @return list<Artifact> */
    public function artifacts(): array
    {
        return $this->artifacts;
    }

    /** @return list<FollowUpAction> */
    public function actions(): array
    {
        return $this->actions;
    }

    public function latestProgress(): ?RunProgress
    {
        return $this->latestProgress;
    }

    /**
     * @return list<array{
     *     kind: 'progress'|'artifact'|'action',
     *     timestamp: string,
     *     value: RunProgress|Artifact|FollowUpAction
     * }>
     */
    public function events(): array
    {
        return $this->events;
    }

    public function close(): void
    {
        $this->open = false;
        $this->cancellationRequested = null;
    }

    public function terminationStatus(): ?RunStatus
    {
        $this->isCancelled();

        return $this->terminationStatus;
    }

    private static function now(): string
    {
        return (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.u\Z');
    }
}
