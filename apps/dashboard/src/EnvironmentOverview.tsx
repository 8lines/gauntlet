import type { OperationSummary } from "@8lines/gauntlet-protocol";
import type { TargetSnapshot } from "./api.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { Card, Badge, EmptyState, Rows } from "./ui.tsx";
import { describeProblem } from "./copy.ts";
import { navigate, routePath } from "./route.ts";

export function EnvironmentOverview({ target }: { target: TargetSnapshot }) {
  const manifest = target.manifest;
  const unavailable =
    manifest?.operations.filter((o) => o.availability.state !== "available") ??
    [];
  const diagnostics = manifest?.diagnostics ?? [];
  const groups = [...(manifest?.features ?? [])].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
  const remaining =
    manifest?.operations.filter(
      (o) => !groups.some((g) => g.id === o.featureId),
    ) ?? [];

  return (
    <>
      <div className="page-heading">
        <p className="page-eyebrow">Environment overview</p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="page-title">{target.label}</h1>
        </div>
        <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
          {manifest === undefined
            ? "The environment did not send a valid operation catalog."
            : `${manifest.operations.length} ${manifest.operations.length === 1 ? "operation" : "operations"} in the catalog. Choose one to prepare a run.`}
        </p>
      </div>
      <div className="page-body space-y-7">
        {manifest !== undefined && (
          <div className="grid grid-cols-3 gap-2 sm:gap-4">
            <Stat
              icon="layers"
              value={manifest.operations.length}
              label="All operations"
              detail="In the environment catalog"
            />
            <Stat
              icon="check"
              value={manifest.operations.length - unavailable.length}
              label="Ready to run"
              detail="Available in this environment"
            />
            <Stat
              icon="shield"
              value={diagnostics.length + unavailable.length}
              label="Need attention"
              detail={
                diagnostics.length + unavailable.length === 0
                  ? "No reported problems"
                  : "Check the diagnostics below"
              }
            />
          </div>
        )}
        {target.problem !== undefined && (
          <Card title="This environment is unreachable">
            <div className="p-5">
              <p className="text-[14px] font-medium text-stop">
                {describeProblem(target.problem).title}
              </p>
              <p className="mt-2 text-[13px] text-muted-foreground">
                {describeProblem(target.problem).advice}
              </p>
            </div>
          </Card>
        )}
        {(diagnostics.length > 0 || unavailable.length > 0) && (
          <Card title="Needs attention">
            <Rows>
              {diagnostics.map((d, i) => (
                <div key={i} className="flex items-start gap-3 px-5 py-4">
                  <Badge tone={d.severity === "error" ? "stop" : "wait"}>
                    {d.severity === "error" ? "error" : "warning"}
                  </Badge>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px]">{d.message}</span>
                    <span className="mono-text mt-1 block break-all text-[11px] text-muted-foreground">
                      {d.code}
                    </span>
                  </span>
                </div>
              ))}
              {unavailable.map((o) => (
                <div key={o.id} className="flex items-start gap-3 px-5 py-4">
                  <Badge tone="wait">unavailable</Badge>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px]">{o.label}</span>
                    <span className="mt-1 block text-[12px] text-muted-foreground">
                      {o.availability.state === "unavailable"
                        ? describeProblem(o.availability.problem).advice
                        : ""}
                    </span>
                  </span>
                </div>
              ))}
            </Rows>
          </Card>
        )}
        {manifest !== undefined && (
          <div className="grid items-start gap-7 xl:grid-cols-[minmax(0,1fr)_260px]">
            <div className="min-w-0">
              <div className="mb-5">
                <h2 className="text-[17px] font-semibold tracking-tight">
                  Operation catalog
                </h2>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  Choose an operation to see its details and prepare a
                  run.
                </p>
              </div>
              <div className="space-y-6">
                {groups.map((g) => (
                  <OperationGroup
                    key={g.id}
                    label={g.label}
                    operations={manifest.operations.filter(
                      (o) => o.featureId === g.id,
                    )}
                    targetId={target.id}
                  />
                ))}
                <OperationGroup
                  label="Other"
                  operations={remaining}
                  targetId={target.id}
                />
                {manifest.operations.length === 0 && (
                  <EmptyState
                    title="The catalog is empty"
                    description="No operations have been made available in this environment yet."
                  />
                )}
              </div>
            </div>
            <div className="space-y-4">
              <div className="rounded-card border border-info-bd bg-info-bg/40 p-5">
                <Icon name="shield" className="mb-3 text-primary" />
                <p className="text-[13px] font-medium">
                  Details first, then action
                </p>
                <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                  Before a run you will see what the operation does. Operations
                  that need confirmation will ask for your approval.
                </p>
              </div>
              {manifest.capabilities.length > 0 && (
                <details className="px-1 text-[12px] text-muted-foreground">
                  <summary className="py-2">Adapter capabilities</summary>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {manifest.capabilities.map((c) => (
                      <Badge key={c}>{c}</Badge>
                    ))}
                  </div>
                </details>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function Stat({
  icon,
  value,
  label,
  detail,
}: {
  icon: IconName;
  value: number;
  label: string;
  detail: string;
}) {
  return (
    <div className="surface-card p-3 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="min-h-8 text-[11px] text-muted-foreground sm:min-h-0 sm:text-[13px]">{label}</p>
        <span className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-control bg-accent/70 text-primary sm:flex">
          <Icon name={icon} className="h-4 w-4" />
        </span>
      </div>
      <p className="mt-2 text-[30px] font-semibold leading-tight tracking-tight tabular-nums">
        {value}
      </p>
      <p className="mt-2 hidden text-[11px] text-muted-foreground sm:block">{detail}</p>
    </div>
  );
}

function OperationGroup({
  label,
  operations,
  targetId,
}: {
  label: string;
  operations: readonly OperationSummary[];
  targetId: string;
}) {
  if (operations.length === 0) return null;
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[12px] font-medium text-muted-foreground">
          {label}
        </h3>
        <span className="text-[11px] text-muted-foreground">
          · {operations.length}
        </span>
      </div>
      <div className="grid gap-3 2xl:grid-cols-2">
        {operations.map((o) => {
          const available = o.availability.state === "available";
          const route = { targetId, operationId: o.id };
          return (
            <a
              key={o.id}
              href={available ? routePath(route) : undefined}
              aria-disabled={!available || undefined}
              onClick={(event) => {
                if (
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                if (available) navigate(route);
              }}
              className={`surface-card operation-link flex min-w-0 items-center gap-4 p-4 ${available ? "" : "opacity-50"}`}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control border border-border bg-muted/50 text-primary">
                <Icon name="play" className="h-[18px] w-[18px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block break-words text-[14px] font-medium">
                  {o.label}
                </span>
                <span className="mt-1 block text-[12px] text-muted-foreground">
                  {available
                    ? "See details and inputs"
                    : "This operation is unavailable"}
                </span>
              </span>
              <Icon name="arrow" className="h-4 w-4 text-muted-foreground" />
            </a>
          );
        })}
      </div>
    </section>
  );
}
