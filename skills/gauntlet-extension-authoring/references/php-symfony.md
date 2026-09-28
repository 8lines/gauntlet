# PHP and Symfony extension

Use the application's already-installed exact `8lines/gauntlet-php-core`
and `8lines/gauntlet-symfony-bundle` versions. Autoconfiguration discovers
only explicitly attributed services. Add application services; do not add a
controller or route.

## Fixed operation

```php
<?php

use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Definition\ExecutionPolicy;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Definition\OperationOutput;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\Core\Run\InvocationContext;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletOperation;
use EightLines\Gauntlet\SymfonyBundle\Input\SymfonyJsonSchemaFactory;
use Symfony\Component\Validator\Constraints as Assert;

final readonly class ResendWelcomeEmailInput
{
    public function __construct(#[Assert\Uuid] public string $userId) {}
}

final readonly class Delivery
{
    public function __construct(public string $deliveryId, public string $status) {}
}

interface GauntletScope
{
    public function requireUserAccess(InvocationContext $context, string $userId): string;
}

interface WelcomeEmailService
{
    public function resend(string $tenantId, string $userId): Delivery;
}

#[AsGauntletOperation]
final readonly class ResendWelcomeEmailOperation implements OperationHandler
{
    public function __construct(
        private SymfonyJsonSchemaFactory $schemas,
        private GauntletScope $scope,
        private WelcomeEmailService $emails,
    ) {}

    public function definition(): OperationDefinition
    {
        return new OperationDefinition(
            id: 'notifications.resend-welcome-email',
            featureId: 'notifications',
            label: 'Resend welcome email',
            description: 'Queues one welcome email for an authorized synthetic user.',
            inputSchema: $this->schemas->forClass(ResendWelcomeEmailInput::class),
            inputHandling: null,
            contextSchema: JsonOwnership::object([
                '$schema' => 'https://json-schema.org/draft/2020-12/schema',
                'type' => 'object',
                'required' => ['requestId', 'actor', 'target'],
                'properties' => [
                    'requestId' => ['type' => 'string', 'minLength' => 1, 'maxLength' => 128],
                    'actor' => [
                        'type' => 'object', 'required' => ['id'],
                        'properties' => [
                            'id' => ['type' => 'string', 'minLength' => 1, 'maxLength' => 128],
                            'displayName' => ['type' => 'string', 'maxLength' => 256],
                        ],
                        'additionalProperties' => false,
                    ],
                    'target' => [
                        'type' => 'object', 'required' => ['id'],
                        'properties' => [
                            'id' => ['type' => 'string', 'minLength' => 1, 'maxLength' => 128],
                            'environment' => ['type' => 'string', 'maxLength' => 128],
                        ],
                        'additionalProperties' => false,
                    ],
                    'locale' => ['type' => 'string', 'maxLength' => 128],
                    'timeZone' => ['type' => 'string', 'maxLength' => 128],
                ],
                'additionalProperties' => false,
            ]),
            uiSchema: null,
            dataSources: [],
            presets: [],
            execution: new ExecutionPolicy(
                impact: OperationImpact::WRITE,
                confirmationRequired: true,
                dryRunSupported: false,
                idempotency: 'required',
                cancellationSupported: false,
                timeoutSeconds: 30,
                concurrency: 'allow',
            ),
            output: new OperationOutput(JsonOwnership::object([
                '$schema' => 'https://json-schema.org/draft/2020-12/schema',
                'type' => 'object',
                'required' => ['deliveryId', 'status'],
                'properties' => [
                    'deliveryId' => ['type' => 'string', 'format' => 'uuid'],
                    'status' => ['type' => 'string', 'enum' => ['queued', 'already-queued']],
                ],
                'additionalProperties' => false,
            ])),
            inputClass: ResendWelcomeEmailInput::class,
        );
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        if (!$input instanceof ResendWelcomeEmailInput) {
            throw new \LogicException('Typed input mapping was bypassed.');
        }
        $invocation = $context->invocationContext()
            ?? throw new \DomainException('Domain access denied.');
        $tenantId = $this->scope->requireUserAccess($invocation, $input->userId);
        $delivery = $this->emails->resend($tenantId, $input->userId);

        return new OperationResult(JsonOwnership::object([
            'deliveryId' => $delivery->deliveryId,
            'status' => $delivery->status,
        ]));
    }
}
```

Register a `notifications` feature provider once. `GauntletScope` and
`WelcomeEmailService` are application-owned interfaces with no request-selected
service or topic. Keep domain exceptions value-free; the adapter normalizes
unexpected failure.

## Focused tests

In PHPUnit, construct the operation with the real
`SymfonyJsonSchemaFactory`, a scope spy, and an email-service spy. Supply a
test `RunContext` whose `invocationContext()` contains fixed actor and target
IDs. Assert the scope is called before the email service, the service is called
once with its returned tenant ID and the UUID, and output contains exactly
`deliveryId` and `status`. In a denial test, make the scope throw and assert
zero email calls.

Then use the application's Symfony kernel client against its existing adapter
route. Test unknown/extra/bad UUID input, missing and stale confirmation,
same-key original-Run replay after changed valid input/request ID with one
service mutation, wrong service output rejected by the runtime, tenant denial,
and secret/error leakage. Pass `idempotencyKey` into create-run/store admission;
`requestId` is correlation only. Verify the operation appears once in the
catalog and no route or container transport was added.
