import type { ReactNode } from "react";
import type { Artifact } from "@8lines/gauntlet-protocol";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { PolicyList } from "./PolicyList.tsx";
import { StatStrip } from "./StatStrip.tsx";
import { LaunchButton } from "./LaunchButton.tsx";

const NOTICE_TONES = { info: "info", success: "ok", warning: "wait", error: "stop" } as const;
const LOG_LEVEL_CLASS = { debug: "text-muted-foreground", info: "text-foreground", warning: "text-warn", error: "text-err" } as const;

const KIND_LABELS: Readonly<Record<string, string>> = {
  notice: "Good to know", metrics: "Metrics", "key-value": "Details", table: "Table",
  json: "Raw result", markdown: "Note", diff: "Changes", timeline: "Timeline",
  log: "Log", download: "File to download", link: "Link", "browser-launch": "Open the application",
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? "Result";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatValue(value: unknown): string {
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

function copyToClipboard(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

export function ArtifactView(
  { artifact, targetId, runId }: { targetId: string; runId: string; artifact: Artifact },
) {
  return (
    <section className="min-w-0 space-y-3">
      <h3 className="text-base/6 font-semibold">{artifact.title ?? kindLabel(artifact.kind)}</h3>
      {renderBody(artifact, targetId, runId)}
    </section>
  );
}

function renderBody(artifact: Artifact, targetId: string, runId: string): ReactNode {
  switch (artifact.kind) {
    case "notice":
      return <PolicyList effects={[{ tone: NOTICE_TONES[artifact.level], text: artifact.message }]} />;

    case "metrics":
      return (
        <StatStrip
          items={artifact.metrics.map((m) => ({
            label: m.name,
            value: m.unit === undefined ? m.value : `${m.value} ${m.unit}`,
          }))}
        />
      );

    case "key-value":
      return (
        <dl className="grid min-w-0 grid-cols-1 gap-y-3 text-sm/5 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)]">
          {artifact.entries.map((e) => (
            <div key={e.key} className="contents">
              <dt className="text-muted-foreground">{e.label}</dt>
              <dd className="flex min-w-0 items-start gap-2">
                <span className="min-w-0 flex-1 break-all font-mono text-xs/4">{formatValue(e.value)}</span>
                <Button
                  type="button" variant="ghost" size="icon-xs" aria-label={`Copy ${e.label}`}
                  onClick={() => copyToClipboard(formatValue(e.value))}
                >
                  <Copy />
                </Button>
              </dd>
            </div>
          ))}
        </dl>
      );

    case "table": {
      const numeric = new Set(
        artifact.columns
          .filter((c) => artifact.rows.length > 0 && artifact.rows.every((row) => typeof row[c.key] === "number"))
          .map((c) => c.key),
      );
      return (
        <div className="max-w-full overflow-x-auto">
          <Table className="min-w-max text-sm/5">
            <TableHeader>
              <TableRow>
                {artifact.columns.map((c) => (
                  <TableHead key={c.key} className={cn(numeric.has(c.key) && "text-right")}>{c.label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {artifact.rows.map((row, i) => (
                <TableRow key={i}>
                  {artifact.columns.map((c) => (
                    <TableCell key={c.key} className={cn("align-baseline", numeric.has(c.key) && "text-right tabular-nums")}>
                      {row[c.key] === undefined || row[c.key] === null ? "" : String(row[c.key])}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      );
    }

    case "markdown":
      return <p className="max-w-[68ch] whitespace-pre-wrap text-sm/5">{artifact.markdown}</p>;

    case "diff":
      return (
        <pre className="overflow-x-auto rounded-lg bg-muted p-4 font-mono text-xs/4">
          {artifact.content.split("\n").map((line, i) => (
            <span
              key={i}
              className={cn("block", line.startsWith("+") ? "text-ok" : line.startsWith("-") ? "text-err" : "text-muted-foreground")}
            >{line}</span>
          ))}
        </pre>
      );

    case "timeline":
      return (
        <ol className="divide-y border-y">
          {artifact.items.map((item, i) => (
            <li key={i} className="flex min-w-0 gap-4 py-3">
              <time className="w-28 shrink-0 break-all font-mono text-xs/4 text-muted-foreground sm:w-44">{item.timestamp}</time>
              <div className="min-w-0 break-words">
                <p className="text-sm/5">{item.title}</p>
                {item.description !== undefined && (
                  <p className="text-[13px]/[18px] text-muted-foreground">{item.description}</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      );

    case "log":
      return (
        <div className="max-h-72 min-w-0 overflow-y-auto overflow-x-hidden rounded-lg bg-muted p-4 font-mono text-xs/4">
          {artifact.entries.map((entry, i) => (
            <div key={i} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-x-3 py-0.5 sm:grid-cols-[minmax(0,auto)_64px_minmax(0,1fr)]">
              <span className="break-all text-muted-foreground">{entry.timestamp ?? ""}</span>
              <span className={LOG_LEVEL_CLASS[entry.level]}>{entry.level}</span>
              <span className="break-all">{entry.message}</span>
            </div>
          ))}
        </div>
      );

    case "download":
      return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-xs/4">{artifact.name}</p>
            <p className="text-[13px]/[18px] text-muted-foreground">
              {artifact.mediaType}{artifact.sizeBytes === undefined ? "" : ` · ${formatSize(artifact.sizeBytes)}`}
            </p>
          </div>
          <Button variant="outline" asChild>
            <a href={artifact.url} download>Download</a>
          </Button>
        </div>
      );

    case "link":
      return (
        <a
          href={artifact.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex min-h-11 items-center text-sm/5 font-medium text-focus underline-offset-4 hover:underline sm:min-h-0"
        >
          {artifact.label} ↗
        </a>
      );

    case "browser-launch":
      return (
        <div className="space-y-3">
          <p className="text-[13px]/[18px] text-muted-foreground">One-time entry. Opening it uses up the link.</p>
          <LaunchButton targetId={targetId} runId={runId} artifactId={artifact.id} label={artifact.label} />
        </div>
      );

    case "json":
      return <pre className="overflow-x-auto rounded-lg bg-muted p-4 font-mono text-xs/4">{JSON.stringify(artifact.value, null, 2)}</pre>;

    default:
      /* Unknown kind from the `urn:` namespace: show it raw instead of skipping it. */
      return (
        <div className="space-y-2">
          <p className="max-w-[68ch] text-sm/5 text-muted-foreground">
            This adapter sent an artifact outside the profile (<span className="font-mono text-xs/4">{artifact.kind}</span>).
          </p>
          <pre className="overflow-x-auto rounded-lg bg-muted p-4 font-mono text-xs/4">
            {JSON.stringify((artifact as { data?: unknown }).data, null, 2)}
          </pre>
        </div>
      );
  }
}
