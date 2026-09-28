<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Http;

use EightLines\Gauntlet\Core\Run\Run;
use EightLines\Gauntlet\Core\Run\RunEvent;
use Symfony\Component\HttpFoundation\StreamedResponse;

final readonly class RunEventStream
{
    public function __construct(
        private CapabilityResponseValidator $validator,
        private ProtocolResponseFactory $responses,
        private StreamConnection $connection,
    ) {
    }

    /** @param iterable<RunEvent> $events */
    public function create(iterable $events, string $expectedRunId): StreamedResponse
    {
        $source = $events;

        return new StreamedResponse(
            function () use (&$source, $expectedRunId): void {
                $iterator = null;
                try {
                    if ($source === null || $this->connection->disconnected()) {
                        return;
                    }
                    $iterator = $this->iterator($source);
                    $iterator->rewind();
                    $previousRun = null;
                    while ($iterator->valid()) {
                        if ($this->connection->disconnected()) {
                            break;
                        }
                        $validated = $this->chunk(
                            $iterator->current(),
                            $expectedRunId,
                            $previousRun,
                        );
                        $this->emit($validated['chunk']);
                        $previousRun = $validated['run'];
                        if ($this->connection->disconnected()) {
                            break;
                        }
                        $iterator->next();
                    }
                } catch (\Throwable) {
                    // Headers may already be sent. Terminate without exposing the failure.
                } finally {
                    $this->release($iterator);
                    $source = null;
                }
            },
            200,
            [
                'Content-Type' => 'text/event-stream; charset=UTF-8',
                'Cache-Control' => 'no-cache',
                'X-Accel-Buffering' => 'no',
            ],
        );
    }

    private function iterator(iterable $events): \Iterator
    {
        if (is_array($events)) {
            return new \ArrayIterator($events);
        }
        if ($events instanceof \Iterator) {
            return $events;
        }
        if ($events instanceof \IteratorAggregate) {
            $events = $events->getIterator();
        }
        if ($events instanceof \Traversable) {
            return new \IteratorIterator($events);
        }

        throw new \UnexpectedValueException('Run event endpoint returned an invalid iterable.');
    }

    /** @return array{chunk: string, run: Run} */
    private function chunk(mixed $event, string $expectedRunId, ?Run $previousRun): array
    {
        if (!$event instanceof RunEvent) {
            throw new \UnexpectedValueException('Run event endpoint returned an invalid event.');
        }
        $validated = $this->validator->event($event, $expectedRunId, $previousRun);
        $document = json_encode(
            $this->responses->normalize($validated['document']),
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES,
        );

        return [
            'chunk' => 'id: ' . $event->id . "\n"
                . "event: run.updated\n"
                . 'data: ' . $document . "\n\n",
            'run' => $validated['run'],
        ];
    }

    private function emit(string $chunk): void
    {
        echo $chunk;
        $this->connection->flush();
    }

    private function release(?\Iterator &$iterator): void
    {
        $owned = $iterator;
        $iterator = null;
        if (is_callable([$owned, 'close'])) {
            try {
                $owned->close();
            } catch (\Throwable) {
            }
        }
        unset($owned);
    }
}
