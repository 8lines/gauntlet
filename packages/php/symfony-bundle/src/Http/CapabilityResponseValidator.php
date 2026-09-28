<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Http;

use EightLines\Gauntlet\Core\Contract\FileReferenceValidator;
use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolValue;
use EightLines\Gauntlet\Core\Result\FileReference;
use EightLines\Gauntlet\Core\Run\Run;
use EightLines\Gauntlet\Core\Run\RunEvent;
use EightLines\Gauntlet\Core\Run\RuntimeGuard;
use EightLines\Gauntlet\Core\Schema\SchemaValidator;
use EightLines\Gauntlet\SymfonyBundle\Capability\CapabilityRegistry;
use EightLines\Gauntlet\SymfonyBundle\Registry\SymfonyAdapterCatalog;
use EightLines\Gauntlet\SymfonyBundle\Registry\SymfonyOperationRegistry;

final class CapabilityResponseValidator
{
    public function __construct(
        private readonly SymfonyAdapterCatalog $catalog,
        private readonly SymfonyOperationRegistry $operations,
        private readonly SchemaValidator $schemaValidator,
        private readonly CapabilityRegistry $capabilities,
        private readonly ProblemSanitizer $problems,
    ) {
    }

    public function run(
        Run $run,
        ?string $expectedRunId = null,
        ?string $expectedOperationId = null,
    ): JsonObject
    {
        $safe = $this->validatedRun($run, $expectedRunId, $expectedOperationId);

        return JsonOwnership::object($safe->toProtocolArray());
    }

    /** @return array{document: JsonObject, run: Run} */
    public function event(
        RunEvent $event,
        string $expectedRunId,
        ?Run $previousRun = null,
    ): array
    {
        $run = $this->validatedRun($event->run, $expectedRunId, null);
        if ($previousRun !== null && !RuntimeGuard::runTransitionIsValid($previousRun, $run)) {
            throw new \UnexpectedValueException('Capability returned an invalid Run transition.');
        }
        $safe = new RunEvent(...[
            ...get_object_vars($event),
            'run' => $run,
        ]);
        if ($safe->sequence !== $run->sequence
            || $safe->occurredAt !== $run->updatedAt
            || !RuntimeGuard::canonicalRunEventIsValid($safe)) {
            throw new \UnexpectedValueException('Capability returned an invalid Run event.');
        }

        return [
            'document' => JsonOwnership::object($safe->toProtocolArray()),
            'run' => $run,
        ];
    }

    public function upload(JsonObject $response): JsonObject
    {
        $owned = $this->owned($response);
        $wire = $this->transport($owned);
        $this->assertMembers($wire, ['file'], ['extensions']);
        $this->assertExtensions($wire);
        if (!$wire->file instanceof \stdClass) {
            throw new \UnexpectedValueException('Upload response file must be an object.');
        }
        $this->assertMembers(
            $wire->file,
            ['kind', 'uploadId', 'name', 'mediaType', 'sizeBytes', 'expiresAt'],
            ['sha256', 'extensions'],
        );
        $this->assertExtensions($wire->file);
        if ($wire->file->kind !== 'file'
            || !is_string($wire->file->uploadId)
            || !is_string($wire->file->name)
            || !is_string($wire->file->mediaType)
            || !is_int($wire->file->sizeBytes)
            || !is_string($wire->file->expiresAt)
            || (property_exists($wire->file, 'sha256') && !is_string($wire->file->sha256))) {
            throw new \UnexpectedValueException('Upload response contains invalid file members.');
        }
        $this->assertStrictTimestamp($wire->file->expiresAt);
        new FileReference(
            uploadId: $wire->file->uploadId,
            name: $wire->file->name,
            mediaType: $wire->file->mediaType,
            sizeBytes: $wire->file->sizeBytes,
            expiresAt: $wire->file->expiresAt,
            sha256: $wire->file->sha256 ?? null,
            extensions: $this->extensions($wire->file),
        );

        return $owned;
    }

    public function session(JsonObject $response, ?\DateTimeImmutable $now = null): JsonObject
    {
        $owned = $this->owned($response);
        $wire = $this->transport($owned);
        $this->assertMembers($wire, ['url', 'expiresAt', 'singleUse'], ['extensions']);
        $this->assertExtensions($wire);
        if (!is_string($wire->url)
            || !is_string($wire->expiresAt)
            || $wire->singleUse !== true) {
            throw new \UnexpectedValueException('Session launch response contains invalid members.');
        }

        $expiresAt = $this->assertStrictTimestamp($wire->expiresAt);
        $current = $now ?? new \DateTimeImmutable('now');
        $ttl = (float) $expiresAt->format('U.u') - (float) $current->format('U.u');
        if ($ttl <= 0 || $ttl > 15 * 60) {
            throw new \UnexpectedValueException('Session launch response has an unsafe expiry.');
        }
        ProtocolValue::assertHttpUrl($wire->url);
        if (filter_var($wire->url, FILTER_VALIDATE_URL) === false) {
            throw new \UnexpectedValueException('Session launch response contains an invalid URL.');
        }
        $url = parse_url($wire->url);
        if (!is_array($url)
            || !isset($url['host'])
            || array_key_exists('user', $url)
            || array_key_exists('pass', $url)) {
            throw new \UnexpectedValueException('Session launch URL must be absolute and credential-free.');
        }

        return $owned;
    }

    private function validatedRun(
        Run $run,
        ?string $expectedRunId,
        ?string $expectedOperationId,
    ): Run {
        if ($run->problem !== null) {
            $run = $run->with(['problem' => $this->problems->sanitizeEmbedded($run->problem)]);
        }
        if (($expectedRunId !== null && $run->id !== $expectedRunId)
            || ($expectedOperationId !== null && $run->operationId !== $expectedOperationId)) {
            throw new \UnexpectedValueException('Capability Run identity does not match its request.');
        }

        $definition = $this->catalog->operationDefinition($run->operationId);
        if ($definition === null || $this->catalog->operationSummary($run->operationId) === null) {
            throw new \UnexpectedValueException('Capability Run references an unknown operation.');
        }
        foreach ($run->actions as $action) {
            if ($action->operationId !== null
                && $this->catalog->operationDefinition($action->operationId) === null) {
                throw new \UnexpectedValueException('Capability Run action references an unknown operation.');
            }
        }

        $fileValidator = $this->capabilities->endpoint('tc-uploads@1');
        if (!RuntimeGuard::storedRunIsValid(
            run: $run,
            expectedId: $expectedRunId ?? $run->id,
            definition: $definition,
            operations: $this->operations->core(),
            validator: $this->schemaValidator,
            fileReferenceValidator: $fileValidator instanceof FileReferenceValidator ? $fileValidator : null,
        )) {
            throw new \UnexpectedValueException('Capability returned an invalid Run.');
        }

        return $run;
    }

    private function owned(JsonObject $value): JsonObject
    {
        $owned = JsonOwnership::own($value);
        if (!$owned instanceof JsonObject) {
            throw new \UnexpectedValueException('Capability response must be an object.');
        }

        return $owned;
    }

    private function transport(JsonObject $value): \stdClass
    {
        $transport = JsonOwnership::transport($value);
        if (!$transport instanceof \stdClass) {
            throw new \UnexpectedValueException('Capability response must be an object.');
        }

        return $transport;
    }

    /** @param list<string> $required @param list<string> $optional */
    private function assertMembers(\stdClass $value, array $required, array $optional = []): void
    {
        $allowed = array_fill_keys([...$required, ...$optional], true);
        foreach (array_keys(get_object_vars($value)) as $member) {
            if (!isset($allowed[$member])) {
                throw new \UnexpectedValueException('Capability response contains an unsupported member.');
            }
        }
        foreach ($required as $member) {
            if (!property_exists($value, $member)) {
                throw new \UnexpectedValueException('Capability response is missing a required member.');
            }
        }
    }

    private function assertExtensions(\stdClass $value): void
    {
        if (property_exists($value, 'extensions')) {
            $this->extensions($value);
        }
    }

    private function extensions(\stdClass $value): ?ProtocolExtensions
    {
        if (!property_exists($value, 'extensions')) {
            return null;
        }
        $extensions = JsonOwnership::own($value->extensions);
        if (!$extensions instanceof JsonObject) {
            throw new \UnexpectedValueException('Capability extensions must be an object.');
        }

        return new ProtocolExtensions($extensions);
    }

    private function assertStrictTimestamp(string $value): \DateTimeImmutable
    {
        ProtocolValue::assertRfc3339($value);
        $timestamp = new \DateTimeImmutable($value);
        $errors = \DateTimeImmutable::getLastErrors();
        if (is_array($errors) && ($errors['warning_count'] !== 0 || $errors['error_count'] !== 0)) {
            throw new \UnexpectedValueException('Capability timestamp is not a real RFC 3339 date-time.');
        }

        return $timestamp;
    }
}
