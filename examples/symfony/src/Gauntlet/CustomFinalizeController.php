<?php

declare(strict_types=1);

namespace Gauntlet\SymfonyExample\Gauntlet;

use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Result\Artifact;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\Core\Run\FollowUpAction;

/**
 * Application-owned binding. It is deliberately not an HTTP controller: the
 * bundle's normalized create-run endpoint is the sole transport surface.
 */
final class CustomFinalizeController
{
    public function __invoke(
        FinalizeAgencyApplicationInput $input,
        RunContext $context,
    ): OperationResult {
        $context->progress(1, 1, 'Agency application finalized');

        return new OperationResult(
            output: JsonOwnership::object(['finalized' => true]),
            summary: [
                'title' => 'Application finalized',
                'tone' => 'success',
                'message' => 'The reference application was finalized.',
            ],
            artifacts: [
                new Artifact(
                    id: 'finalize-result',
                    kind: 'key-value',
                    data: JsonOwnership::object([
                        'title' => 'Finalization result',
                        'entries' => [[
                            'key' => 'applicationId',
                            'label' => 'Application',
                            'value' => $input->applicationId,
                        ]],
                    ]),
                ),
                new Artifact(
                    id: 'conformance-browser-session',
                    kind: 'browser-launch',
                    data: JsonOwnership::object([
                        'label' => 'Open synthetic application',
                    ]),
                ),
            ],
            actions: [
                new FollowUpAction(
                    kind: 'browser-launch',
                    label: 'Open application',
                    artifactId: 'conformance-browser-session',
                ),
            ],
        );
    }
}
