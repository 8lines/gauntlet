<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Integration;

final class AdapterDisabledHttpTest extends BundleWebTestCase
{
    public function testDisabledGateWinsBeforeRoutingAndBodyParsingForWholePrefix(): void
    {
        $client = self::createClient(['environment' => 'disabled']);
        self::assertFalse(self::getContainer()->getParameter('gauntlet.enabled'));

        foreach ([
            ['GET', '/_gauntlet/v1/operations/unsafe%21id', null],
            ['POST', '/_gauntlet/v1/uploads', '{not-json'],
            ['PATCH', '/_gauntlet/v1/manifest?query=forbidden', null],
            ['GET', '/_gauntlet/v1/unknown/extra/segments', null],
        ] as [$method, $uri, $body]) {
            $client->request($method, $uri, content: $body);
            self::assertResponseStatusCodeSame(503);
            self::assertResponseHeaderSame('Content-Type', 'application/problem+json');
            self::assertSame(
                'urn:gauntlet:problem:adapter-disabled',
                $this->responseJson($client->getResponse())['type'],
            );
        }
    }

    public function testDisabledGateDoesNotCaptureHostApplicationRoutes(): void
    {
        $client = self::createClient(['environment' => 'disabled']);
        $client->request('GET', '/host-route');

        self::assertResponseStatusCodeSame(404);
        self::assertNotSame('application/problem+json', $client->getResponse()->headers->get('Content-Type'));
    }
}
