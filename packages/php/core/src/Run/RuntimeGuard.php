<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Run;

use EightLines\Gauntlet\Core\Contract\FileReferenceValidator;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Json\JsonValue;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Json\Rfc8785CanonicalJson;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Registry\OperationRegistry;
use EightLines\Gauntlet\Core\Result\Artifact;
use EightLines\Gauntlet\Core\Schema\SchemaValidator;

final class RuntimeGuard
{
    public static function canonicalRunIsValid(Run $run): bool
    {
        try {
            $copy = new Run(...get_object_vars($run));
            if ($copy->progress !== null) {
                new RunProgress(...get_object_vars($copy->progress));
            }
            if (!self::timestampsAreChronological($copy)) {
                return false;
            }
            Rfc8785CanonicalJson::encode(JsonOwnership::object($copy->toProtocolArray()));

            return true;
        } catch (\Throwable) {
            return false;
        }
    }

    public static function canonicalRunEventIsValid(RunEvent $event): bool
    {
        try {
            $copy = new RunEvent(...get_object_vars($event));
            if (!self::canonicalRunIsValid($copy->run)) {
                return false;
            }
            Rfc8785CanonicalJson::encode(JsonOwnership::object($copy->toProtocolArray()));

            return true;
        } catch (\Throwable) {
            return false;
        }
    }

    public static function runTransitionIsValid(Run $previous, Run $next): bool
    {
        try {
            if ($next->id !== $previous->id
                || $next->operationId !== $previous->operationId
                || $next->operationRevision !== $previous->operationRevision
                || $next->createdAt !== $previous->createdAt
                || $next->sequence < $previous->sequence) {
                return false;
            }

            $previousCanonical = Rfc8785CanonicalJson::encode(
                JsonOwnership::object($previous->toProtocolArray()),
            );
            $nextCanonical = Rfc8785CanonicalJson::encode(
                JsonOwnership::object($next->toProtocolArray()),
            );
            if ($next->sequence === $previous->sequence) {
                return $previousCanonical === $nextCanonical;
            }
            if ($previous->state->terminal()
                || ($previous->state === RunStatus::RUNNING && $next->state === RunStatus::QUEUED)
                || self::timestamp($next->updatedAt) < self::timestamp($previous->updatedAt)) {
                return false;
            }
            if (($previous->startedAt !== null && $next->startedAt !== $previous->startedAt)
                || ($previous->completedAt !== null && $next->completedAt !== $previous->completedAt)) {
                return false;
            }
            if ($previous->progress !== null
                && $next->progress !== null
                && self::timestamp($next->progress->updatedAt)
                    < self::timestamp($previous->progress->updatedAt)) {
                return false;
            }

            return true;
        } catch (\Throwable) {
            return false;
        }
    }

    public static function storedRunIsValid(
        Run $run,
        string $expectedId,
        OperationDefinition $definition,
        OperationRegistry $operations,
        SchemaValidator $validator,
        ?FileReferenceValidator $fileReferenceValidator = null,
    ): bool {
        if (
            $run->id !== $expectedId
            || $run->operationId !== $definition->id
            || $run->operationRevision !== $definition->revision()
        ) {
            return false;
        }

        try {
            if (!self::canonicalRunIsValid($run)) {
                return false;
            }

            if ($run->output !== null && $validator->validate($definition->output->schema, $run->output) !== []) {
                return false;
            }
            return self::validateProjection(
                $run->output,
                $run->progress,
                $run->summary,
                $run->problem,
                $run->artifacts,
                $run->actions,
                $definition,
                $operations,
                $validator,
                [],
                $fileReferenceValidator,
            ) === null;
        } catch (\Throwable) {
            return false;
        }
    }

    public static function assertActive(Run $run): ?Problem
    {
        return $run->state->terminal()
            ? new Problem('urn:gauntlet:problem:validation-failed', 'Run is terminal', 422)
            : null;
    }

    /**
     * @param list<Artifact> $artifacts
     * @param list<FollowUpAction> $actions
     * @param array<string,true> $sourceSecrets
     */
    public static function validateProjection(
        ?JsonValue $output,
        ?RunProgress $progress,
        ?RunSummary $summary,
        ?Problem $problem,
        array $artifacts,
        array $actions,
        OperationDefinition $definition,
        OperationRegistry $operations,
        SchemaValidator $validator,
        array $sourceSecrets,
        ?FileReferenceValidator $fileReferenceValidator = null,
    ): ?Problem {
        try {
            if ($output !== null) {
                Rfc8785CanonicalJson::encode($output);
                if ($validator->validate($definition->output->schema, $output) !== []) {
                    return self::invalidResult();
                }
                if (InputHandlingGuard::containsAny($output, $sourceSecrets)) {
                    return self::invalidResult();
                }
            }
            foreach ([$progress, $summary, $problem] as $projection) {
                if ($projection === null) {
                    continue;
                }
                $wire = $projection->toProtocolArray();
                Rfc8785CanonicalJson::encode(JsonOwnership::object($wire));
                if (InputHandlingGuard::containsAny($wire, $sourceSecrets)) {
                    return self::invalidResult();
                }
            }

            $artifactsById = [];
            foreach ($artifacts as $artifact) {
                if (!$artifact instanceof Artifact || isset($artifactsById[$artifact->id])) {
                    return self::invalidResult();
                }
                Rfc8785CanonicalJson::encode(JsonOwnership::object($artifact->toProtocolArray()));
                if (InputHandlingGuard::containsAny($artifact->toProtocolArray(), $sourceSecrets)) {
                    return self::invalidResult();
                }
                $artifactsById[$artifact->id] = $artifact;
            }

            foreach ($actions as $action) {
                if (!$action instanceof FollowUpAction) {
                    return self::invalidResult();
                }
                Rfc8785CanonicalJson::encode(JsonOwnership::object($action->toProtocolArray()));
                if (InputHandlingGuard::containsAny($action->toProtocolArray(), $sourceSecrets)) {
                    return self::invalidResult();
                }

                if ($action->kind === 'browser-launch') {
                    $artifact = $action->artifactId === null
                        ? null
                        : ($artifactsById[$action->artifactId] ?? null);
                    if ($artifact === null || $artifact->kind !== 'browser-launch') {
                        return self::invalidResult();
                    }
                    continue;
                }
                if ($action->kind !== 'invoke-operation') {
                    continue;
                }

                $target = $action->operationId === null
                    ? null
                    : $operations->definition($action->operationId);
                if ($target === null) {
                    return self::invalidResult();
                }
                $input = $action->input ?? JsonOwnership::object([]);
                if ($validator->validate($target->inputSchema, $input) !== []) {
                    return self::invalidResult();
                }
                if (
                    $target->inputHandling !== null
                    && InputHandlingGuard::containsSecret($target->inputHandling, $input, $target->inputSchema)
                ) {
                    return self::invalidResult();
                }
                if (InputHandlingGuard::validate($target, $input, $fileReferenceValidator) !== null) {
                    return self::invalidResult();
                }
            }

            return null;
        } catch (\Throwable) {
            return self::invalidResult();
        }
    }

    private static function invalidResult(): Problem
    {
        return new Problem(
            'urn:gauntlet:problem:adapter-internal-error',
            'Adapter internal error',
            500,
        );
    }

    private static function timestampsAreChronological(Run $run): bool
    {
        $createdAt = self::timestamp($run->createdAt);
        $updatedAt = self::timestamp($run->updatedAt);
        $startedAt = $run->startedAt === null ? null : self::timestamp($run->startedAt);
        $completedAt = $run->completedAt === null ? null : self::timestamp($run->completedAt);
        $progressAt = $run->progress === null ? null : self::timestamp($run->progress->updatedAt);

        return $updatedAt >= $createdAt
            && ($startedAt === null || ($startedAt >= $createdAt && $startedAt <= $updatedAt))
            && ($completedAt === null || ($completedAt <= $updatedAt && $completedAt >= ($startedAt ?? $createdAt)))
            && ($progressAt === null || ($progressAt >= ($startedAt ?? $createdAt) && $progressAt <= $updatedAt));
    }

    private static function timestamp(string $value): float
    {
        $timestamp = (new \DateTimeImmutable($value))->format('U.u');

        return (float) $timestamp;
    }
}
