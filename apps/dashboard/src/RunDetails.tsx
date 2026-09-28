import { useEffect, useRef, useState } from "react";
import type {
  Artifact, FollowUpAction, Problem, Run, SessionLaunchResponse,
} from "@8lines/gauntlet-protocol";
import { api, type Result } from "./api.ts";
import { navigate, routePath, type Route } from "./route.ts";
import { Card, ActivityIndicator, EffectList, Badge, Button, Rows } from "./ui.tsx";
import { describeProblem, runStateLabel } from "./copy.ts";

type DirectFollowUpAction = Extract<FollowUpAction, { kind: "invoke-operation" | "open-link" }>;

export interface FollowUpEffects {
  readonly navigate: (route: Route) => void;
  readonly open: (url: string) => void;
}

const defaultFollowUpEffects: FollowUpEffects = {
  navigate: navigate,
  open: (url) => { globalThis.open(url, "_blank", "noopener,noreferrer"); },
};

export function followUpPath(
  action: Extract<FollowUpAction, { kind: "invoke-operation" }>,
  targetId: string,
): string {
  return routePath({ targetId, operationId: action.operationId });
}

export function executeFollowUp(
  action: DirectFollowUpAction,
  targetId: string,
  effects: FollowUpEffects = defaultFollowUpEffects,
): void {
  if (action.kind === "invoke-operation") {
    effects.navigate({
      targetId,
      operationId: action.operationId,
      ...(action.input === undefined ? {} : { input: action.input }),
    });
    return;
  }
  effects.open(action.url);
}

export interface BrowserPopup {
  readonly navigate: (url: string) => void;
  readonly close: () => void;
}

export interface BrowserLaunchDependencies {
  readonly openBlank: () => BrowserPopup | null;
  readonly launch: (targetId: string, runId: string, artifactId: string) => Promise<Result<SessionLaunchResponse>>;
}

export interface BrowserLaunchAttempt {
  readonly result: Promise<Problem | undefined>;
  readonly cancel: () => void;
}

const POPUP_BLOCKED: Problem = Object.freeze({
  type: "urn:gauntlet:problem:popup-blocked",
  title: "The browser blocked the new window",
  status: 0,
  detail: "Allow Gauntlet to open new windows and try again.",
});

const defaultBrowserLaunchDependencies: BrowserLaunchDependencies = {
  openBlank: () => {
    const popup = globalThis.open("about:blank", "_blank");
    if (popup === null) return null;
    popup.opener = null;
    return {
      navigate: (url) => { popup.location.replace(url); },
      close: () => { popup.close(); },
    };
  },
  launch: api.launchArtifact,
};

export function beginBrowserLaunch(
  targetId: string,
  runId: string,
  artifactId: string,
  dependencies: BrowserLaunchDependencies = defaultBrowserLaunchDependencies,
): BrowserLaunchAttempt {
  const popup = dependencies.openBlank();
  if (popup === null) {
    return { result: Promise.resolve(POPUP_BLOCKED), cancel: () => undefined };
  }

  let current = true;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    popup.close();
  };
  const cancel = () => {
    if (!current) return;
    current = false;
    close();
  };
  const result = (async (): Promise<Problem | undefined> => {
    const response = await dependencies.launch(targetId, runId, artifactId);
    if (!current) { close(); return undefined; }
    current = false;
    if (!response.ok) { close(); return response.problem; }
    popup.navigate(response.data.url);
    return undefined;
  })();
  return { result, cancel };
}

export function RunDetails(
  { targetId, run, onCancel, onRetry }:
  { targetId: string; run: Run; onCancel?: (() => void) | undefined; onRetry: () => void },
) {
  const state = runStateLabel(run.state);
  const active = run.state === "queued" || run.state === "running";
  const progress = run.progress;

  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <div className="p-4">
          <div className="flex flex-wrap items-center gap-2.5">
            <Badge tone={state.tone}>
              {state.label}
              {active && <ActivityIndicator className="ml-1.5" />}
            </Badge>
            {run.summary !== undefined && <span className="text-[14px] font-medium">{run.summary.title}</span>}
          </div>

          {run.summary?.message !== undefined && (
            <p className="mt-1.5 text-[13px] text-muted-foreground">{run.summary.message}</p>
          )}

          {progress !== undefined && active && (
            <div className="mt-3">
              <div className="flex items-baseline justify-between text-[12px] text-muted-foreground">
                <span className="mono-text">{progress.phase ?? "in progress"}</span>
                {progress.total !== undefined && progress.current !== undefined && (
                  <span className="tabular-nums">{progress.current} of {progress.total}</span>
                )}
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: progress.total !== undefined && progress.current !== undefined && progress.total > 0
                    ? `${Math.round((progress.current / progress.total) * 100)}%` : "40%" }}
                />
              </div>
              {progress.message !== undefined && <p className="mt-2 text-[13px] text-muted-foreground">{progress.message}</p>}
            </div>
          )}

          {run.problem !== undefined && (
            <div className="mt-3 rounded-control border border-stop-bd bg-stop-bg p-3">
              <p className="text-[13px] font-medium text-stop">{describeProblem(run.problem).title}</p>
              <p className="mt-1 text-[13px] text-muted-foreground">{describeProblem(run.problem).advice}</p>
              {run.problem.correlationId !== undefined && (
                <p className="mono-text mt-2 text-[11px] text-muted-foreground">
                  correlation ID: {run.problem.correlationId}
                </p>
              )}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {active && onCancel !== undefined && <Button onClick={onCancel}>Cancel run</Button>}
            {active && onCancel === undefined && (
              <span className="text-[12px] text-muted-foreground">This application does not allow cancelling an operation once it has started.</span>
            )}
            {!active && <Button variant="primary" onClick={onRetry}>Run again</Button>}
          </div>
        </div>
      </Card>

      {run.artifacts.length > 0 && (
        <div className="space-y-3">
          {run.artifacts.map((a) => <ArtifactView key={a.id} artifact={a} targetId={targetId} runId={run.id} />)}
        </div>
      )}

      {run.actions.length > 0 && (
        <Card title="What next">
          <Rows>
            {run.actions.map((action, i) => (
              <FollowUpRow key={i} action={action} targetId={targetId} runId={run.id} />
            ))}
          </Rows>
        </Card>
      )}
    </div>
  );
}

function FollowUpRow(
  { action, targetId, runId }: { action: FollowUpAction; targetId: string; runId: string },
) {
  const description =
    action.kind === "open-link" ? action.url
    : action.kind === "browser-launch" ? "opens the application in a new tab"
    : "opens the next operation with the form filled in";
  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]">{action.label}</span>
        <span className="block truncate text-[12px] text-muted-foreground">{description}</span>
      </span>
      {action.kind === "invoke-operation" && (
        <Button onClick={() => executeFollowUp(action, targetId)}>Open</Button>
      )}
      {action.kind === "open-link" && (
        <a
          href={action.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex min-h-11 shrink-0 items-center text-[12px] font-medium text-info hover:underline sm:min-h-0"
        >Open ↗</a>
      )}
      {action.kind === "browser-launch" && (
        <LaunchButton targetId={targetId} runId={runId} artifactId={action.artifactId} />
      )}
    </div>
  );
}

function ArtifactView(
  { artifact, targetId, runId }: { artifact: Artifact; targetId: string; runId: string },
) {
  const title = artifact.title ?? kindLabel(artifact.kind);

  switch (artifact.kind) {
    case "notice": {
      const tones = { info: "info", success: "ok", warning: "wait", error: "stop" } as const;
      return (
        <Card title={title}>
          <div className="p-4">
            <EffectList items={[{ tone: tones[artifact.level], text: artifact.message }]} />
          </div>
        </Card>
      );
    }

    case "metrics":
      return (
        <Card title={title}>
          <div className="flex flex-wrap gap-8 p-4">
            {artifact.metrics.map((m) => (
              <span key={m.name}>
                <span className="block text-[20px] font-semibold tabular-nums tracking-tight">{m.value}</span>
                <span className="mt-0.5 block text-[12px] text-muted-foreground">{m.name}{m.unit === undefined ? "" : ` · ${m.unit}`}</span>
              </span>
            ))}
          </div>
        </Card>
      );

    case "key-value":
      return (
        <Card title={title}>
          <dl className="grid min-w-0 grid-cols-1 gap-y-2 p-4 text-[13px] sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)]">
            {artifact.entries.map((e) => (
              <div key={e.key} className="contents">
                <dt className="text-muted-foreground">{e.label}</dt>
                <dd className="mono-text text-[12px] break-all">{String(e.value)}</dd>
              </div>
            ))}
          </dl>
        </Card>
      );

    case "table":
      return (
        <Card title={title}>
          <div className="max-w-full overflow-x-auto">
            <table className="min-w-max text-[13px]">
              <thead>
                <tr className="border-b border-border bg-muted/60 text-[12px] text-muted-foreground">
                  {artifact.columns.map((c) => <th key={c.key} className="px-4 py-2.5 text-left font-semibold">{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {artifact.rows.map((row, i) => (
                  <tr key={i} className="border-b border-border transition-colors last:border-0 hover:bg-muted/40">
                    {artifact.columns.map((c) => (
                      <td key={c.key} className="px-4 py-3">{String(row[c.key] ?? "—")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      );

    case "markdown":
      return (
        <Card title={title}>
          <p className="whitespace-pre-wrap p-4 text-[13px] text-muted-foreground">{artifact.markdown}</p>
        </Card>
      );

    case "diff":
      return (
        <Card title={title}>
          <pre className="mono-text overflow-x-auto p-4 text-[11px] leading-relaxed">
            {artifact.content.split("\n").map((line, i) => (
              <span
                key={i}
                className={`block ${line.startsWith("+") ? "bg-ok-bg text-ok" : line.startsWith("-") ? "bg-stop-bg text-stop" : "text-muted-foreground"}`}
              >{line}</span>
            ))}
          </pre>
        </Card>
      );

    case "timeline":
      return (
        <Card title={title}>
          <Rows>
            {artifact.items.map((item, i) => (
              <div key={i} className="flex min-w-0 gap-3 px-4 py-2.5">
                <span className="mono-text w-24 shrink-0 break-all text-[11px] text-muted-foreground sm:w-40">{item.timestamp}</span>
                <span className="min-w-0 break-words">
                  <span className="block text-[13px]">{item.title}</span>
                  {item.description !== undefined && <span className="block text-[12px] text-muted-foreground">{item.description}</span>}
                </span>
              </div>
            ))}
          </Rows>
        </Card>
      );

    case "log": {
      const colors = { debug: "text-muted-foreground", info: "text-info", warning: "text-wait", error: "text-stop" } as const;
      return (
        <Card title={title}>
          <div className="mono-text max-h-72 min-w-0 overflow-x-hidden overflow-y-auto p-4 text-[11px]">
            {artifact.entries.map((entry, i) => (
              <div key={i} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-x-3 py-0.5 sm:grid-cols-[minmax(0,auto)_60px_minmax(0,1fr)]">
                <span className="break-all text-muted-foreground">{entry.timestamp ?? ""}</span>
                <span className={colors[entry.level]}>{entry.level}</span>
                <span className="break-all">{entry.message}</span>
              </div>
            ))}
          </div>
        </Card>
      );
    }

    case "download":
      return (
        <Card title={title}>
          <div className="flex items-center gap-3 p-4">
            <span className="rounded-badge bg-muted px-1.5 py-1 text-[10px] font-semibold text-muted-foreground">file</span>
            <span className="min-w-0 flex-1">
              <span className="mono-text block truncate text-[12px]">{artifact.name}</span>
              <span className="block text-[12px] text-muted-foreground">
                {artifact.mediaType}{artifact.sizeBytes === undefined ? "" : ` · ${formatSize(artifact.sizeBytes)}`}
              </span>
            </span>
            <a href={artifact.url} download className="inline-flex min-h-11 shrink-0 items-center text-[12px] font-medium text-info hover:underline sm:min-h-0">Download</a>
          </div>
        </Card>
      );

    case "link":
      return (
        <Card title={title}>
          <div className="p-4">
            <a href={artifact.url} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-11 items-center text-[13px] font-medium text-info hover:underline sm:min-h-0">
              {artifact.label} ↗
            </a>
          </div>
        </Card>
      );

    case "browser-launch":
      return (
        <Card title={title}>
          <div className="m-4 rounded-control border border-dashed border-info-bd bg-info-bg p-4">
            <p className="text-[13px] font-medium text-info">{artifact.label}</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">One-time entry — opening it uses up the link.</p>
            <div className="mt-3">
              <LaunchButton targetId={targetId} runId={runId} artifactId={artifact.id} />
            </div>
          </div>
        </Card>
      );

    case "json":
      return (
        <Card title={title}>
          <pre className="mono-text overflow-x-auto p-4 text-[11px]">{JSON.stringify(artifact.value, null, 2)}</pre>
        </Card>
      );

    default:
      /* Unknown kind from the `urn:` namespace — show it raw instead of skipping it. */
      return (
        <Card title={title}>
          <div className="p-4">
            <p className="mb-2 text-[12px] text-muted-foreground">
              This adapter sent an artifact outside the profile (<span className="font-mono">{artifact.kind}</span>).
            </p>
            <pre className="mono-text overflow-x-auto text-[11px]">{JSON.stringify((artifact as { data?: unknown }).data, null, 2)}</pre>
          </div>
        </Card>
      );
  }
}

function LaunchButton(
  { targetId, runId, artifactId }: { targetId: string; runId: string; artifactId: string },
) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem>();
  const mounted = useRef(false);
  const generation = useRef(0);
  const activeAttempt = useRef<BrowserLaunchAttempt | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      activeAttempt.current?.cancel();
      activeAttempt.current = undefined;
    };
  }, []);

  const launch = () => {
    activeAttempt.current?.cancel();
    const requestGeneration = generation.current + 1;
    generation.current = requestGeneration;
    setPending(true);
    setProblem(undefined);
    const attempt = beginBrowserLaunch(targetId, runId, artifactId);
    activeAttempt.current = attempt;
    void attempt.result.then((launchProblem) => {
      if (!mounted.current || generation.current !== requestGeneration) return;
      activeAttempt.current = undefined;
      setPending(false);
      setProblem(launchProblem);
    });
  };

  return (
    <div>
      <Button disabled={pending} onClick={launch}>
        {pending ? "Opening…" : "Open"}
      </Button>
      {problem !== undefined && (
        <div className="mt-2 rounded-control border border-stop-bd bg-stop-bg p-2" role="alert">
          <p className="text-[12px] font-medium text-stop">{describeProblem(problem).title}</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{describeProblem(problem).advice}</p>
        </div>
      )}
    </div>
  );
}

function kindLabel(kind: string): string {
  const names: Readonly<Record<string, string>> = {
    notice: "Good to know", metrics: "Metrics", "key-value": "Details", table: "Table",
    json: "Raw result", markdown: "Note", diff: "Changes", timeline: "Timeline",
    log: "Log", download: "File to download", link: "Link", "browser-launch": "Open the application",
  };
  return names[kind] ?? "Result";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
