<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App;

use Symfony\Component\Validator\Constraints as Assert;

final readonly class EchoInput
{
    public function __construct(
        #[Assert\NotBlank]
        #[Assert\Uuid]
        public string $applicationId,
    ) {
    }
}
