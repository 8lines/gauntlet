import { useId, useMemo, useState, type ReactNode } from "react";
import type { OperationDefinition } from "@8lines/gauntlet-protocol";
import { ChevronDown, CircleHelp, Code2, History, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { browserStorage } from "../../browser-storage.ts";
import { policyEffects } from "../../copy.ts";
import { readRecentRuns, type RecentRun } from "../../recent-runs.ts";
import { followRoute, routePath } from "../../route.ts";
import { useRecentRunStates } from "../../useRecentRunStates.ts";
import { PolicyList } from "./PolicyList.tsx";
import { RecentRunRow } from "./RecentRunsList.tsx";

/** Context for one operation, shared by the desktop inspector and the narrow-screen sheet. */
export function OperationDetails({ definition, targetId, environment, recentRunsVersion, currentRunId, onOpenRun, onNavigate }: {
  definition: OperationDefinition;
  targetId: string;
  environment: string | undefined;
  recentRunsVersion: number;
  currentRunId: string | undefined;
  onOpenRun: ((entry: RecentRun) => void) | undefined;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col divide-y">
      <DetailSection title="What this operation does" icon={<Info />} defaultOpen>
        <OperationBehavior definition={definition} />
      </DetailSection>
      <DetailSection title="Your recent runs" icon={<History />} hint={HISTORY_HINT} defaultOpen>
        <OperationHistory
          definition={definition} targetId={targetId} recentRunsVersion={recentRunsVersion}
          currentRunId={currentRunId} onOpenRun={onOpenRun} onNavigate={onNavigate}
        />
      </DetailSection>
      <DetailSection title="Definition" icon={<Code2 />}>
        <OperationDefinitionInfo definition={definition} targetId={targetId} environment={environment} />
      </DetailSection>
    </div>
  );
}

export const HISTORY_HINT = "This operation in this environment, from this browser.";

/** The description and the execution policy. */
export function OperationBehavior({ definition }: { definition: OperationDefinition }) {
  return (
    <>
      {definition.description !== undefined && <p className="text-sm/5 break-words text-muted-foreground">{definition.description}</p>}
      <PolicyList effects={policyEffects(definition.execution)} />
    </>
  );
}

/** Identity, revision and the raw definition JSON. */
export function OperationDefinitionInfo({ definition, targetId, environment }: {
  definition: OperationDefinition;
  targetId: string;
  environment: string | undefined;
}) {
  return (
    <>
      <dl className="flex flex-col gap-4 text-[13px]/[18px]">
        <DefinitionItem label="Defined by">{environment ?? targetId}</DefinitionItem>
        <DefinitionItem label="Operation ID" mono>{definition.id}</DefinitionItem>
        <DefinitionItem label="Feature" mono>{definition.featureId}</DefinitionItem>
        <DefinitionItem label="Revision" mono>{definition.revision}</DefinitionItem>
      </dl>
      <p className="text-xs/4 text-muted-foreground">The application does not report a source file location.</p>
      <details className="min-w-0 rounded-md border bg-background">
        <summary className="cursor-pointer rounded-md px-3 py-2 text-[13px]/[18px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">View definition JSON</summary>
        <pre tabIndex={0} aria-label="Operation definition JSON" className="max-h-96 overflow-auto border-t p-3 font-mono text-xs/5 outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {JSON.stringify(definition, null, 2)}
        </pre>
      </details>
    </>
  );
}

export function DetailSection({ title, icon, hint, defaultOpen = false, className, children }: {
  title: string;
  icon: ReactNode;
  hint?: string;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Collapsible defaultOpen={defaultOpen} className={cn("min-w-0 px-5 py-4", className)}>
      <div className="relative flex items-center gap-1.5 pr-6">
        <h2 className="min-w-0">
          <CollapsibleTrigger id={id} className="group flex items-center gap-2 rounded-sm text-left text-sm/5 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span aria-hidden="true" className="text-muted-foreground [&>svg]:size-4 [&>svg]:shrink-0">{icon}</span>
            <span className="min-w-0">{title}</span>
            <ChevronDown aria-hidden="true" className="absolute right-0 size-3.5 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
        </h2>
        {hint !== undefined && <SectionHint label={`About ${title.toLowerCase()}`} text={hint} />}
      </div>
      <CollapsibleContent role="region" aria-labelledby={id} className="min-w-0">
        <div className="flex min-w-0 flex-col gap-4 pt-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SectionHint({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button type="button" aria-label={label} className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={(event) => { event.preventDefault(); setOpen((value) => !value); }}>
            <CircleHelp className="size-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="max-w-64 rounded-lg px-3 py-2 text-left text-xs/5 shadow-md duration-150">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function DefinitionItem({ label, mono = false, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs/4 text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-xs/5 break-all" : "break-words"}>{children}</dd>
    </div>
  );
}

/** Runs of this operation started from this browser, newest first. */
export function OperationHistory({ definition, targetId, recentRunsVersion, currentRunId, onOpenRun, onNavigate }: {
  definition: OperationDefinition;
  targetId: string;
  recentRunsVersion: number;
  currentRunId: string | undefined;
  onOpenRun: ((entry: RecentRun) => void) | undefined;
  onNavigate?: (() => void) | undefined;
}) {
  const entries = useMemo(
    () => readRecentRuns(browserStorage).filter((entry) => entry.targetId === targetId && entry.operationId === definition.id),
    [targetId, definition.id, recentRunsVersion, currentRunId],
  );
  const states = useRecentRunStates(entries);
  if (entries.length === 0) return <p className="text-[13px]/[18px] text-muted-foreground">No runs yet. Runs you start here will appear in this list.</p>;
  return (
    <ul className="flex min-w-0 flex-col divide-y">
      {entries.map((entry) => {
        const route = { targetId, operationId: entry.operationId, runId: entry.runId };
        return <RecentRunRow
          key={entry.runId}
          entry={{ ...entry, label: entry.runId }}
          state={states.get(entry.runId)}
          action={onOpenRun === undefined
            ? { href: routePath(route), onClick: (event) => { followRoute(event, route); if (event.defaultPrevented) onNavigate?.(); } }
            : { onOpen: () => { onNavigate?.(); onOpenRun(entry); } }}
        />;
      })}
    </ul>
  );
}
