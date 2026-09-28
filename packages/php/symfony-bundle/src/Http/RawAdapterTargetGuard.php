<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Http;

use EightLines\Gauntlet\Core\Problem\Problem;

final class RawAdapterTargetGuard
{
    public const PREFIX = '/_gauntlet/v1';

    public function isAdapterTarget(string $rawTarget): bool
    {
        return $rawTarget === self::PREFIX || str_starts_with($rawTarget, self::PREFIX . '/');
    }

    public function requestTargetsAdapter(string $rawTarget, string $normalizedPath): bool
    {
        if ($this->isAdapterTarget($rawTarget) || $this->isAdapterTarget($normalizedPath)) {
            return true;
        }

        $rawPath = parse_url($rawTarget, PHP_URL_PATH);
        if (!is_string($rawPath)) {
            return false;
        }

        return $this->isAdapterTarget(rawurldecode($rawPath));
    }

    public function inspectRequest(string $rawTarget, string $normalizedPath, string $method): ?Problem
    {
        if (!$this->requestTargetsAdapter($rawTarget, $normalizedPath)) {
            return null;
        }
        if (!$this->isAdapterTarget($rawTarget)) {
            return $this->invalidPath();
        }

        return $this->inspect($rawTarget, $method);
    }

    public function inspect(string $rawTarget, string $method): ?Problem
    {
        if (!$this->isAdapterTarget($rawTarget)) {
            return null;
        }
        if (!mb_check_encoding($rawTarget, 'UTF-8')
            || str_contains($rawTarget, '?')
            || str_contains($rawTarget, '#')
            || str_contains($rawTarget, '%')
            || str_contains($rawTarget, '\\')
            || preg_match('/\s/u', $rawTarget) === 1
            || str_contains($rawTarget, '//')
            || str_ends_with($rawTarget, '/')
            || preg_match('#(?:^|/)\.\.?(?:/|$)#', $rawTarget) === 1) {
            return $this->invalidPath();
        }

        if ($rawTarget === self::PREFIX) {
            return $this->notFound();
        }

        $relative = substr($rawTarget, strlen(self::PREFIX) + 1);
        $segments = explode('/', $relative);
        $root = $segments[0] ?? '';

        $expectedMethod = null;
        if (count($segments) === 1 && in_array($root, ['health', 'manifest'], true)) {
            $expectedMethod = 'GET';
        } elseif (count($segments) === 1 && $root === 'uploads') {
            $expectedMethod = 'POST';
        } elseif (count($segments) === 2 && $root === 'operations') {
            if (!$this->safeId($segments[1])) {
                return $this->invalidPath();
            }
            $expectedMethod = 'GET';
        } elseif (count($segments) === 2 && $root === 'runs') {
            if (!$this->safeId($segments[1])) {
                return $this->invalidPath();
            }
            $expectedMethod = 'GET';
        } elseif (count($segments) === 3 && $root === 'operations' && $segments[2] === 'runs') {
            if (!$this->safeId($segments[1])) {
                return $this->invalidPath();
            }
            $expectedMethod = 'POST';
        } elseif (count($segments) === 3
            && $root === 'data-sources'
            && in_array($segments[2], ['query', 'resolve'], true)) {
            if (!$this->safeId($segments[1])) {
                return $this->invalidPath();
            }
            $expectedMethod = 'POST';
        } elseif (count($segments) === 3 && $root === 'runs' && in_array($segments[2], ['cancel', 'events'], true)) {
            if (!$this->safeId($segments[1])) {
                return $this->invalidPath();
            }
            $expectedMethod = $segments[2] === 'cancel' ? 'POST' : 'GET';
        } elseif (count($segments) === 5
            && $root === 'runs'
            && $segments[2] === 'artifacts'
            && $segments[4] === 'launch') {
            if (!$this->safeId($segments[1]) || !$this->safeId($segments[3])) {
                return $this->invalidPath();
            }
            $expectedMethod = 'POST';
        } elseif (in_array($root, ['health', 'manifest', 'uploads', 'operations', 'runs', 'data-sources'], true)) {
            return $this->invalidPath();
        } else {
            return $this->notFound();
        }

        if (strtoupper($method) !== $expectedMethod) {
            return new Problem(
                type: 'urn:gauntlet:problem:method-not-allowed',
                title: 'Method not allowed',
                status: 405,
            );
        }

        return null;
    }

    private function safeId(string $id): bool
    {
        return preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/D', $id) === 1;
    }

    private function invalidPath(): Problem
    {
        return new Problem(
            type: 'urn:gauntlet:problem:invalid-path',
            title: 'Invalid adapter path',
            status: 400,
        );
    }

    private function notFound(): Problem
    {
        return new Problem(
            type: 'urn:gauntlet:problem:route-not-found',
            title: 'Adapter route not found',
            status: 404,
        );
    }
}
