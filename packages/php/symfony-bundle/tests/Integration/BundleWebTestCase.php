<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Integration;

use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\FixtureKernel;
use Symfony\Bundle\FrameworkBundle\KernelBrowser;
use Symfony\Bundle\FrameworkBundle\Test\WebTestCase;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\KernelInterface;

abstract class BundleWebTestCase extends WebTestCase
{
    protected static function getKernelClass(): string
    {
        return FixtureKernel::class;
    }

    protected static function createKernel(array $options = []): KernelInterface
    {
        return new FixtureKernel(
            $options['environment'] ?? 'test',
            $options['debug'] ?? true,
        );
    }

    /** @return array<string, mixed> */
    protected function responseJson(Response $response): array
    {
        $content = $response->getContent();
        self::assertIsString($content);

        return json_decode($content, true, flags: JSON_THROW_ON_ERROR);
    }

    /** @param array<string, mixed> $body */
    protected function postJson(KernelBrowser $client, string $uri, array $body): Response
    {
        $client->request(
            'POST',
            $uri,
            server: ['CONTENT_TYPE' => 'application/json'],
            content: json_encode($body, JSON_THROW_ON_ERROR),
        );

        return $client->getResponse();
    }

    protected function operationRevision(KernelBrowser $client, string $operationId = 'fixture.echo'): string
    {
        $client->request('GET', '/_gauntlet/v1/operations/' . $operationId);

        return $this->responseJson($client->getResponse())['revision'];
    }
}
