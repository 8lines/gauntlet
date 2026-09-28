<?php

declare(strict_types=1);

namespace Gauntlet\SymfonyExample\Gauntlet;

use EightLines\Gauntlet\Core\Contract\RunStore;
use EightLines\Gauntlet\Core\Json\JsonList;
use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Problem\ValidationError;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Result\Artifact;
use EightLines\Gauntlet\Core\Run\FollowUpAction;
use EightLines\Gauntlet\Core\Run\Run;
use EightLines\Gauntlet\Core\Run\RunProgress;
use EightLines\Gauntlet\Core\Run\RunStatus;
use EightLines\Gauntlet\Core\Run\RunStoreCreateResult;
use EightLines\Gauntlet\Core\Run\RunSummary;

/**
 * Small durable reference store for the executable example.
 *
 * Real applications should bind RunStore to their own database-backed
 * implementation. This fixture persists only validated Run snapshots and
 * HMAC fingerprints; operation inputs and raw idempotency keys never enter it.
 */
final class SqliteRunStore implements RunStore
{
    /** @var list<class-string> */
    private const ALLOWED_CLASSES = [
        Artifact::class,
        FollowUpAction::class,
        JsonList::class,
        JsonObject::class,
        Problem::class,
        ProtocolExtensions::class,
        Run::class,
        RunProgress::class,
        RunStatus::class,
        RunSummary::class,
        ValidationError::class,
    ];

    private \PDO $database;

    public function __construct(string $path)
    {
        if ($path === '' || str_contains($path, "\0")) {
            throw new \InvalidArgumentException('Run store path must be non-empty.');
        }

        $directory = dirname($path);
        if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) {
            throw new \RuntimeException('Unable to create the Run store directory.');
        }

        $this->database = new \PDO('sqlite:' . $path, options: [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_STRINGIFY_FETCHES => false,
        ]);
        $this->database->exec('PRAGMA busy_timeout = 5000');
        $this->database->exec(
            <<<'SQL'
                CREATE TABLE IF NOT EXISTS gauntlet_runs (
                    id TEXT PRIMARY KEY,
                    operation_id TEXT NOT NULL,
                    operation_revision TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    fingerprint TEXT NULL,
                    payload TEXT NOT NULL
                )
                SQL,
        );
        $this->database->exec(
            <<<'SQL'
                CREATE UNIQUE INDEX IF NOT EXISTS gauntlet_runs_fingerprint
                ON gauntlet_runs (operation_id, fingerprint)
                WHERE fingerprint IS NOT NULL
                SQL,
        );
        if (is_file($path)) {
            chmod($path, 0600);
        }
    }

    public function createQueued(Run $run, ?string $idempotencyFingerprint = null): RunStoreCreateResult
    {
        if ($run->state !== RunStatus::QUEUED || $run->sequence !== 0) {
            throw new \InvalidArgumentException('RunStore can only create a sequence-zero queued Run.');
        }

        $transactionActive = false;
        try {
            $this->database->exec('BEGIN IMMEDIATE');
            $transactionActive = true;
            if ($idempotencyFingerprint !== null) {
                $winner = $this->fetchByFingerprint($run->operationId, $idempotencyFingerprint);
                if ($winner !== null) {
                    $this->database->exec('COMMIT');
                    $transactionActive = false;

                    return RunStoreCreateResult::duplicate($winner);
                }
            }

            $winner = $this->fetchById($run->id);
            if ($winner !== null) {
                $this->database->exec('COMMIT');
                $transactionActive = false;

                return RunStoreCreateResult::duplicate($winner);
            }

            $statement = $this->database->prepare(
                <<<'SQL'
                    INSERT INTO gauntlet_runs (
                        id,
                        operation_id,
                        operation_revision,
                        sequence,
                        created_at,
                        fingerprint,
                        payload
                    ) VALUES (
                        :id,
                        :operation_id,
                        :operation_revision,
                        :sequence,
                        :created_at,
                        :fingerprint,
                        :payload
                    )
                    SQL,
            );
            $statement->execute([
                'id' => $run->id,
                'operation_id' => $run->operationId,
                'operation_revision' => $run->operationRevision,
                'sequence' => $run->sequence,
                'created_at' => $run->createdAt,
                'fingerprint' => $idempotencyFingerprint,
                'payload' => self::encode($run),
            ]);
            $this->database->exec('COMMIT');
            $transactionActive = false;

            return RunStoreCreateResult::created($run);
        } catch (\Throwable $error) {
            if ($transactionActive) {
                try {
                    $this->database->exec('ROLLBACK');
                } catch (\Throwable $rollbackError) {
                    throw new \RuntimeException('Unable to roll back the Run reservation.', 0, $error);
                }
            }

            throw $error;
        }
    }

    public function get(string $runId): ?Run
    {
        return $this->fetchById($runId);
    }

    public function findByIdempotencyFingerprint(string $operationId, string $fingerprint): ?Run
    {
        return $this->fetchByFingerprint($operationId, $fingerprint);
    }

    public function updateExactSequence(Run $run, int $expectedPreviousSequence): bool
    {
        if ($run->sequence !== $expectedPreviousSequence + 1) {
            return false;
        }

        $statement = $this->database->prepare(
            <<<'SQL'
                UPDATE gauntlet_runs
                SET sequence = :next_sequence, payload = :payload
                WHERE id = :id
                  AND sequence = :previous_sequence
                  AND operation_id = :operation_id
                  AND operation_revision = :operation_revision
                  AND created_at = :created_at
                SQL,
        );
        $statement->execute([
            'next_sequence' => $run->sequence,
            'payload' => self::encode($run),
            'id' => $run->id,
            'previous_sequence' => $expectedPreviousSequence,
            'operation_id' => $run->operationId,
            'operation_revision' => $run->operationRevision,
            'created_at' => $run->createdAt,
        ]);

        return $statement->rowCount() === 1;
    }

    private function fetchById(string $runId): ?Run
    {
        $statement = $this->database->prepare(
            'SELECT payload FROM gauntlet_runs WHERE id = :id',
        );
        $statement->execute(['id' => $runId]);

        return self::decode($statement->fetchColumn());
    }

    private function fetchByFingerprint(string $operationId, string $fingerprint): ?Run
    {
        $statement = $this->database->prepare(
            <<<'SQL'
                SELECT payload
                FROM gauntlet_runs
                WHERE operation_id = :operation_id AND fingerprint = :fingerprint
                SQL,
        );
        $statement->execute([
            'operation_id' => $operationId,
            'fingerprint' => $fingerprint,
        ]);

        return self::decode($statement->fetchColumn());
    }

    private static function encode(Run $run): string
    {
        return base64_encode(serialize($run));
    }

    private static function decode(mixed $payload): ?Run
    {
        if ($payload === false) {
            return null;
        }
        if (!is_string($payload)) {
            throw new \RuntimeException('Invalid stored Run payload.');
        }

        $serialized = base64_decode($payload, true);
        if ($serialized === false) {
            throw new \RuntimeException('Invalid stored Run payload.');
        }

        try {
            $run = unserialize($serialized, ['allowed_classes' => self::ALLOWED_CLASSES]);
        } catch (\Throwable) {
            throw new \RuntimeException('Invalid stored Run payload.');
        }
        if (!$run instanceof Run) {
            throw new \RuntimeException('Invalid stored Run payload.');
        }

        return $run;
    }

}
