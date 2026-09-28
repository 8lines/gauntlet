<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Result;

use EightLines\Gauntlet\Core\Json\JsonValue;
use EightLines\Gauntlet\Core\Run\FollowUpAction;
use EightLines\Gauntlet\Core\Run\RunSummary;

final readonly class OperationResult
{
    public ?JsonValue $output;
    public ?RunSummary $summary;

    /** @var list<Artifact> */
    public array $artifacts;

    /** @var list<FollowUpAction> */
    public array $actions;

    /**
     * The array summary form remains accepted at the public constructor for
     * source compatibility, but is immediately normalized into RunSummary.
     *
     * @param RunSummary|array{title:string,tone?:string,message?:string}|null $summary
     * @param list<Artifact> $artifacts
     * @param list<FollowUpAction> $actions
     */
    public function __construct(
        ?JsonValue $output = null,
        RunSummary|array|null $summary = null,
        array $artifacts = [],
        array $actions = [],
    ) {
        $this->output = $output;
        $this->summary = is_array($summary) ? self::summaryFromArray($summary) : $summary;
        foreach ($artifacts as $artifact) {
            if (!$artifact instanceof Artifact) {
                throw new \InvalidArgumentException('Result artifacts must be typed Artifact values.');
            }
        }
        foreach ($actions as $action) {
            if (!$action instanceof FollowUpAction) {
                throw new \InvalidArgumentException('Result actions must be typed FollowUpAction values.');
            }
        }
        $this->artifacts = $artifacts;
        $this->actions = $actions;
    }

    /** @param array<string, mixed> $summary */
    private static function summaryFromArray(array $summary): RunSummary
    {
        $allowed = ['title', 'tone', 'message'];
        foreach (array_keys($summary) as $key) {
            if (!is_string($key) || !in_array($key, $allowed, true)) {
                throw new \InvalidArgumentException('Invalid result summary.');
            }
        }
        if (!isset($summary['title']) || !is_string($summary['title'])) {
            throw new \InvalidArgumentException('Result summary requires a title.');
        }

        return new RunSummary(
            $summary['title'],
            isset($summary['tone']) && is_string($summary['tone']) ? $summary['tone'] : 'neutral',
            isset($summary['message']) && is_string($summary['message']) ? $summary['message'] : null,
        );
    }
}
