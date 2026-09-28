<?php

declare(strict_types=1);

namespace Gauntlet\SymfonyExample\Gauntlet;

use Symfony\Component\Validator\Constraints as Assert;

final readonly class FinalizeAgencyApplicationInput
{
    public function __construct(
        #[Assert\NotBlank]
        #[Assert\Uuid]
        public string $applicationId,
        #[Assert\NotBlank]
        #[Assert\Regex('/^[0-9]{6}$/')]
        public string $confirmationCode,
    ) {
    }
}
