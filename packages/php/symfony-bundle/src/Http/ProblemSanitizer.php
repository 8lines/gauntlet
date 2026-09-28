<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Http;

use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Problem\ValidationError;

final class ProblemSanitizer
{
    private const CORE_CAPABILITIES = [
        'tc-run-cancellation@1',
        'tc-run-sse@1',
        'tc-uploads@1',
        'tc-session-launch@1',
    ];

    public function sanitize(Problem $problem, ?string $expectedCapability = null): Problem
    {
        return $this->sanitizeForTransport($problem, $expectedCapability, true);
    }

    public function sanitizeEmbedded(Problem $problem): Problem
    {
        return $this->sanitizeForTransport($problem, null, false);
    }

    private function sanitizeForTransport(
        Problem $problem,
        ?string $expectedCapability,
        bool $includeFailureCorrelation,
    ): Problem
    {
        return match ($problem->type) {
            'urn:gauntlet:problem:adapter-disabled' => $this->simple(
                $problem,
                'Adapter disabled',
                503,
            ),
            'urn:gauntlet:problem:unsupported-capability' => $this->capability(
                $problem,
                $expectedCapability,
            ),
            'urn:gauntlet:problem:operation-not-found' => $this->simple(
                $problem,
                'Operation not found',
                404,
            ),
            'urn:gauntlet:problem:run-not-found' => $this->simple($problem, 'Run not found', 404),
            'urn:gauntlet:problem:data-source-not-found' => $this->simple(
                $problem,
                'Data source not found',
                404,
            ),
            'urn:gauntlet:problem:artifact-not-found' => $this->simple(
                $problem,
                'Artifact not found',
                404,
            ),
            'urn:gauntlet:problem:route-not-found' => $this->simple($problem, 'Route not found', 404),
            'urn:gauntlet:problem:method-not-allowed' => $this->simple(
                $problem,
                'Method not allowed',
                405,
            ),
            'urn:gauntlet:problem:invalid-json' => $this->simple($problem, 'Invalid JSON', 400),
            'urn:gauntlet:problem:invalid-path' => $this->simple($problem, 'Invalid path', 400),
            'urn:gauntlet:problem:unsupported-media-type' => $this->simple(
                $problem,
                'Unsupported media type',
                415,
            ),
            'urn:gauntlet:problem:request-too-large' => $this->simple(
                $problem,
                'Request body is too large',
                413,
            ),
            'urn:gauntlet:problem:validation-failed' => $this->validation($problem),
            'urn:gauntlet:problem:stale-operation-revision' => $this->simple(
                $problem,
                'Operation revision is stale',
                409,
            ),
            'urn:gauntlet:problem:operation-busy' => $this->simple(
                $problem,
                'Operation busy',
                409,
            ),
            'urn:gauntlet:problem:run-not-cancellable' => $this->simple(
                $problem,
                'Run is not cancellable',
                409,
            ),
            'urn:gauntlet:problem:run-cancelled' => $this->simple(
                $problem,
                'Run cancelled',
                409,
            ),
            'urn:gauntlet:problem:run-timed-out' => $this->simple(
                $problem,
                'Run timed out',
                504,
            ),
            'urn:gauntlet:problem:handler-failed' => $this->failure(
                $problem,
                'Operation failed',
                $includeFailureCorrelation,
            ),
            'urn:gauntlet:problem:adapter-invalid-response' => $this->simple(
                $problem,
                'Invalid adapter response',
                502,
            ),
            'urn:gauntlet:problem:adapter-unavailable' => $this->unavailable($problem),
            'urn:gauntlet:problem:requirements-unavailable' => $this->simple(
                $problem,
                'Operation requirements are unavailable',
                501,
            ),
            'urn:gauntlet:problem:adapter-internal-error' => $this->failure(
                $problem,
                'Adapter internal error',
                $includeFailureCorrelation,
            ),
            default => throw new \UnexpectedValueException('Problem type is not safe for transport.'),
        };
    }

    private function simple(Problem $problem, string $title, int $status): Problem
    {
        $this->assertStatus($problem, $status);

        return new Problem($problem->type, $title, $status);
    }

    private function failure(Problem $problem, string $title, bool $includeCorrelation): Problem
    {
        $this->assertStatus($problem, 500);

        return new Problem(
            $problem->type,
            $title,
            500,
            correlationId: $includeCorrelation ? ProblemResponseFactory::correlationId() : null,
        );
    }

    private function capability(Problem $problem, ?string $expectedCapability): Problem
    {
        $this->assertStatus($problem, 501);
        $capability = $expectedCapability ?? $problem->capability;
        if ($capability === null
            || !in_array($capability, self::CORE_CAPABILITIES, true)
            || $problem->capability !== $capability) {
            throw new \UnexpectedValueException('Problem capability does not match the requested endpoint.');
        }

        return new Problem(
            type: $problem->type,
            title: 'Unsupported capability',
            status: 501,
            detail: 'The adapter does not advertise or implement this capability.',
            capability: $capability,
        );
    }

    private function validation(Problem $problem): Problem
    {
        $this->assertStatus($problem, 422);
        $errors = [];
        foreach (array_slice($problem->errors, 0, 100) as $error) {
            $errors[] = new ValidationError(
                instancePath: $this->pointer($error->instancePath, ''),
                schemaPath: $this->pointer($error->schemaPath, '#'),
                keyword: preg_match('/^[A-Za-z0-9._:-]{1,64}$/D', $error->keyword) === 1
                    ? $error->keyword
                    : 'validation',
                message: 'Value does not satisfy schema.',
                params: JsonOwnership::object([]),
            );
        }

        return Problem::validation($errors);
    }

    private function unavailable(Problem $problem): Problem
    {
        $this->assertStatus($problem, 503);

        return new Problem(
            type: $problem->type,
            title: 'Operation unavailable',
            status: 503,
            detail: 'The operation requirements are not available in this adapter.',
        );
    }

    private function assertStatus(Problem $problem, int $status): void
    {
        if ($problem->status !== $status) {
            throw new \UnexpectedValueException('Problem status does not match its transport type.');
        }
    }

    private function pointer(string $value, string $fallback): string
    {
        if (!mb_check_encoding($value, 'UTF-8')
            || strlen($value) > 512
            || preg_match('/[\x00-\x1F\x7F]/', $value) === 1) {
            return $fallback;
        }
        if ($fallback === '') {
            return $value === '' || str_starts_with($value, '/') ? $value : '';
        }

        return $value === '#' || str_starts_with($value, '#/') ? $value : '#';
    }
}
