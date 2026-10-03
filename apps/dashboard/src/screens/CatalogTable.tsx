import type { AdapterManifest, OperationDefinition, OperationSummary } from "@8lines/gauntlet-protocol";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ImpactBadge } from "../components/gauntlet/ImpactBadge.tsx";
import { policySummary } from "../catalog.ts";
import { describeProblem } from "../copy.ts";
import { followRoute, routePath } from "../route.ts";

export interface CatalogGroup {
  readonly id: string;
  readonly label: string;
  readonly operations: readonly OperationSummary[];
}

/** What the overview knows about an available operation's definition: nothing yet, failed, or loaded. */
export type CatalogDetails = Readonly<Record<string, { readonly definition?: OperationDefinition } | undefined>>;

/** Operations grouped by feature in manifest order; operations of unknown features go last under "Other". */
export function groupOperations(manifest: AdapterManifest, operations: readonly OperationSummary[]): readonly CatalogGroup[] {
  const features = [...manifest.features].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const groups: CatalogGroup[] = features.map((feature) => ({
    id: feature.id,
    label: feature.label,
    operations: operations.filter((operation) => operation.featureId === feature.id),
  }));
  const other = operations.filter((operation) => !features.some((feature) => feature.id === operation.featureId));
  if (other.length > 0) groups.push({ id: "other", label: "Other", operations: other });
  return groups.filter((group) => group.operations.length > 0);
}

const LINK = "rounded-sm break-words underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
const ROW_LABEL = "px-2 py-3 text-left align-baseline text-sm/5 font-medium";
const CELL = "px-2 py-3 align-baseline text-sm/5 font-normal whitespace-normal";

export function CatalogTable({ targetId, targetLabel, groups, details }: {
  targetId: string;
  targetLabel: string;
  groups: readonly CatalogGroup[];
  details: CatalogDetails;
}) {
  return (
    <div className="overflow-hidden rounded-lg border">
    <Table>
      <caption className="sr-only">Operations in {targetLabel}, grouped by feature</caption>
      <TableHeader className="bg-muted/40">
        <TableRow>
          <TableHead scope="col" className="w-[40%] px-2 text-sm/5 font-medium text-muted-foreground">Operation</TableHead>
          <TableHead scope="col" className="w-[18%] px-2 text-sm/5 font-medium text-muted-foreground">Impact</TableHead>
          <TableHead scope="col" className="px-2 text-sm/5 font-medium text-muted-foreground max-sm:hidden">Before you run</TableHead>
        </TableRow>
      </TableHeader>
      {groups.map((group) => (
        <TableBody key={group.id}>
          <TableRow className="hover:bg-transparent">
            <th scope="rowgroup" colSpan={3} className="px-2 py-2 text-left align-baseline text-sm/5 font-medium">
              {group.label} <span className="font-normal text-muted-foreground">{group.operations.length}</span>
            </th>
          </TableRow>
          {group.operations.map((operation) => (
            <OperationRow key={operation.id} targetId={targetId} operation={operation} details={details[operation.id]} />
          ))}
        </TableBody>
      ))}
    </Table>
    </div>
  );
}

function OperationRow({ targetId, operation, details }: {
  targetId: string;
  operation: OperationSummary;
  details: { readonly definition?: OperationDefinition } | undefined;
}) {
  const id = <span className="block font-mono text-xs/4 font-normal break-all text-muted-foreground">{operation.id}</span>;

  if (operation.availability.state !== "available") {
    return (
      <TableRow aria-disabled="true" className="hover:bg-transparent">
        <th scope="row" className={ROW_LABEL}>
          <span className="break-words text-muted-foreground">{operation.label}</span>
          {id}
          {operation.availability.state === "unavailable" && (
            <span className="mt-1 block text-[13px]/[18px] font-normal text-muted-foreground sm:hidden">
              {describeProblem(operation.availability.problem).advice}
            </span>
          )}
        </th>
        <TableCell className={CELL}><Badge variant="outline" className="font-normal">Unavailable</Badge></TableCell>
        <TableCell className={`${CELL} text-muted-foreground max-sm:hidden`}>
          {operation.availability.state === "unavailable" ? describeProblem(operation.availability.problem).advice : ""}
        </TableCell>
      </TableRow>
    );
  }

  const route = { targetId, operationId: operation.id };
  const definition = details?.definition;
  return (
    <TableRow>
      <th scope="row" className={ROW_LABEL}>
        <a href={routePath(route)} onClick={(event) => followRoute(event, route)} className={LINK}>{operation.label}</a>
        {id}
        {definition !== undefined && (
          <span className="mt-1 block text-[13px]/[18px] font-normal text-muted-foreground sm:hidden">{policySummary(definition)}</span>
        )}
      </th>
      <TableCell className={CELL}>
        {definition !== undefined
          ? <ImpactBadge impact={definition.execution.impact} />
          : <span className="text-muted-foreground">{details === undefined ? "Loading" : "Details unavailable"}</span>}
      </TableCell>
      <TableCell className={`${CELL} text-muted-foreground max-sm:hidden`}>
        {definition === undefined ? "" : policySummary(definition)}
      </TableCell>
    </TableRow>
  );
}
