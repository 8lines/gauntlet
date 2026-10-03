import { Check, ChevronsUpDown } from "lucide-react";
import type { Tone } from "../copy.ts";
import { formatRelativeTime } from "../copy.ts";
import { navigate } from "../route.ts";
import type { TargetSnapshot } from "../api.ts";
import { StateMark } from "@/components/gauntlet/StateMark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";

export function targetStateTone(target: TargetSnapshot): Tone {
  return target.state === "online" ? "ok" : target.state === "degraded" ? "wait" : "stop";
}

export function targetStateLabel(target: TargetSnapshot): "Online" | "Degraded" | "Unavailable" {
  return target.state === "online" ? "Online" : target.state === "degraded" ? "Degraded" : "Unavailable";
}

function targetDetail(target: TargetSnapshot): string {
  const application = target.manifest?.application;
  const parts = application === undefined
    ? ["No environment details"]
    : [application.label, application.environment.kind];
  return [...parts, targetStateLabel(target)].join(", ");
}

export function EnvironmentSwitcher({ targets, selected }: {
  targets: readonly TargetSnapshot[] | undefined;
  selected: TargetSnapshot | undefined;
}) {
  const { isMobile } = useSidebar();
  if (targets === undefined) return <Skeleton className="h-12 w-full" />;
  if (selected === undefined) return null;
  const application = selected.manifest?.application;
  const kind = application?.environment.kind;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" aria-label={`Choose environment: ${selected.label}`}>
              <span className="grid min-w-0 flex-1 gap-1">
                <span className="truncate text-sm/5 font-medium">{selected.label}</span>
                <span className="flex items-center gap-2 text-xs/4 text-muted-foreground">
                  <StateMark tone={targetStateTone(selected)} />
                  <span className="truncate">
                    {targetStateLabel(selected)}{kind === undefined ? "" : ` · ${kind}`}
                  </span>
                </span>
              </span>
              <ChevronsUpDown aria-hidden="true" className="text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side={isMobile ? "bottom" : "right"}
            align="start"
            className="w-(--radix-dropdown-menu-trigger-width) min-w-72 md:w-96"
          >
            <DropdownMenuLabel className="text-xs/4 font-medium text-muted-foreground">Environments</DropdownMenuLabel>
            {targets.map((target) => (
              <DropdownMenuItem
                key={target.id}
                aria-current={target.id === selected.id ? "true" : undefined}
                onSelect={() => {
                  if (target.id !== selected.id) navigate({ targetId: target.id });
                }}
                className="items-start gap-2"
              >
                <span className="mt-0.5"><StateMark tone={targetStateTone(target)} /></span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="text-sm/5 font-medium break-words">{target.label}</span>
                  <span className="text-[13px]/[18px] break-words text-muted-foreground">{targetDetail(target)}</span>
                </span>
                {target.id === selected.id && <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <dl className="flex flex-col gap-1 px-2 py-1.5 text-[13px]/[18px]">
              {application !== undefined && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Application</dt>
                  <dd className="min-w-0 text-right break-words">{application.label}</dd>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Refreshed</dt>
                <dd>{formatRelativeTime(selected.refreshedAt)}</dd>
              </div>
            </dl>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
