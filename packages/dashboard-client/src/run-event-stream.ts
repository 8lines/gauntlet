import {
  runSemanticsAreValid,
  runTransitionIsValid,
  type Run,
  type RunEvent,
} from "@8lines/gauntlet-protocol";
import { protocolValidators, validates } from "./protocol-validator.js";

export interface AdapterRunEventStream extends AsyncIterable<RunEvent> {
  cancel(): Promise<void>;
}

class AdapterEventStreamError extends Error {
  constructor() {
    super("Adapter event stream failed");
  }
}

interface EventFrame {
  id?: string;
  event?: string;
  readonly data: string[];
}

function field(line: string): readonly [string, string] {
  const separator = line.indexOf(":");
  if (separator < 0) return [line, ""];
  const raw = line.slice(separator + 1);
  return [line.slice(0, separator), raw.startsWith(" ") ? raw.slice(1) : raw];
}

function deepFreezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function eventFromFrame(
  frame: EventFrame,
  expectedRunId: string,
  previousRun: Run | undefined,
): RunEvent {
  if (frame.id === undefined || frame.event !== "run.updated" || frame.data.length === 0) {
    throw new AdapterEventStreamError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data.join("\n")) as unknown;
  } catch {
    throw new AdapterEventStreamError();
  }
  if (!validates(protocolValidators.runEvent, parsed)
    || parsed.id !== frame.id
    || parsed.type !== frame.event
    || parsed.run.id !== expectedRunId
    || parsed.sequence !== parsed.run.sequence
    || parsed.occurredAt !== parsed.run.updatedAt
    || !runSemanticsAreValid(parsed.run)
    || (previousRun !== undefined && !runTransitionIsValid(previousRun, parsed.run))) {
    throw new AdapterEventStreamError();
  }
  return deepFreezeJson(parsed);
}

export function createAdapterRunEventStream(
  response: Response,
  expectedRunId: string,
  maxEventBytes: number,
  abort: () => void,
): AdapterRunEventStream {
  const body = response.body;
  if (body === null) throw new AdapterEventStreamError();

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let started = false;
  let closed = false;
  let cancelled = false;

  const events = (async function* (): AsyncGenerator<RunEvent> {
    started = true;
    reader = body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let lineChunks: Uint8Array[] = [];
    let lineBytes = 0;
    let frameBytes = 0;
    let frame: EventFrame = { data: [] };
    let previousRun: Run | undefined;
    let skipLineFeed = false;
    let completed = false;

    const append = (chunk: Uint8Array): void => {
      if (chunk.byteLength === 0) return;
      lineChunks.push(chunk.slice());
      lineBytes += chunk.byteLength;
      frameBytes += chunk.byteLength;
      if (frameBytes > maxEventBytes) throw new AdapterEventStreamError();
    };
    const takeLine = (): string => {
      const bytes = new Uint8Array(lineBytes);
      let offset = 0;
      for (const chunk of lineChunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      lineChunks = [];
      lineBytes = 0;
      return decoder.decode(bytes);
    };
    const consumeLine = (line: string): RunEvent | undefined => {
      if (line === "") {
        if (frame.id === undefined && frame.event === undefined && frame.data.length === 0) {
          frameBytes = 0;
          return undefined;
        }
        const event = eventFromFrame(frame, expectedRunId, previousRun);
        previousRun = event.run;
        frame = { data: [] };
        frameBytes = 0;
        return event;
      }
      if (line.startsWith(":")) return undefined;
      const [name, value] = field(line);
      if (name === "id") {
        if (frame.id !== undefined || value.includes("\u0000")) throw new AdapterEventStreamError();
        frame.id = value;
      } else if (name === "event") {
        if (frame.event !== undefined) throw new AdapterEventStreamError();
        frame.event = value;
      } else if (name === "data") {
        frame.data.push(value);
      } else {
        throw new AdapterEventStreamError();
      }
      return undefined;
    };

    try {
      while (!cancelled) {
        const next = await reader.read();
        if (next.done) {
          if (lineBytes !== 0
            || frame.id !== undefined
            || frame.event !== undefined
            || frame.data.length !== 0) {
            throw new AdapterEventStreamError();
          }
          completed = true;
          return;
        }
        const bytes = next.value;
        let segmentStart = 0;
        for (let index = 0; index < bytes.byteLength; index += 1) {
          const byte = bytes[index]!;
          if (skipLineFeed) {
            skipLineFeed = false;
            if (byte === 0x0a) {
              segmentStart = index + 1;
              continue;
            }
          }
          if (byte !== 0x0a && byte !== 0x0d) continue;
          append(bytes.subarray(segmentStart, index));
          const event = consumeLine(takeLine());
          if (byte === 0x0d) skipLineFeed = true;
          segmentStart = index + 1;
          if (event !== undefined) yield event;
        }
        append(bytes.subarray(segmentStart));
      }
    } catch {
      if (!cancelled) throw new AdapterEventStreamError();
    } finally {
      if (!completed) {
        try {
          await reader.cancel();
        } catch {
          // The public stream failure/cancellation remains fixed.
        }
      }
      reader.releaseLock();
      reader = undefined;
      closed = true;
    }
  })();

  return Object.freeze({
    [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
      return events;
    },
    async cancel(): Promise<void> {
      if (closed || cancelled) return;
      cancelled = true;
      abort();
      try {
        if (reader !== undefined) {
          await reader.cancel();
          await events.return(undefined);
        } else if (!started) {
          await body.cancel();
          closed = true;
        }
      } catch {
        // Cancellation is best-effort and never exposes transport details.
      }
    },
  });
}
