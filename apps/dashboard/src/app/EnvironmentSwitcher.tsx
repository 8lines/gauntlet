import { Fragment, useId } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import type { Tone } from "../copy.ts";
import { formatRelativeTime } from "../copy.ts";
import { navigate } from "../route.ts";
import type { TargetSnapshot } from "../api.ts";
import { environmentGroups, environmentNames, environmentTitle } from "./environment-groups.ts";
import { StateMark } from "@/components/gauntlet/StateMark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function targetStateTone(target: TargetSnapshot): Tone {
  return target.state === "online" ? "ok" : target.state === "degraded" ? "wait" : "stop";
}

export function targetStateLabel(target: TargetSnapshot): "Online" | "Degraded" | "Unavailable" {
  return target.state === "online" ? "Online" : target.state === "degraded" ? "Degraded" : "Unavailable";
}

function itemDetail(target: TargetSnapshot): string {
  const { kind } = environmentNames(target);
  const state = target.state === "online" ? undefined : targetStateLabel(target);
  return [kind, state].filter((part) => part !== undefined).join(" · ");
}

export function EnvironmentSwitcher({ targets, selected }: {
  targets: readonly TargetSnapshot[] | undefined;
  selected: TargetSnapshot | undefined;
}) {
  const { isMobile } = useSidebar();
  const groupId = useId();
  if (targets === undefined) return <Skeleton className="h-12 w-full" />;
  if (selected === undefined) return null;
  const names = environmentNames(selected);
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="h-auto min-h-12 w-full min-w-0 justify-between px-3 py-2 text-left" aria-label={`Choose environment: ${environmentTitle(selected)}`}>
              <span className="grid min-w-0 flex-1 gap-1">
                <span className="truncate text-sm/5 font-medium">{names.application}</span>
                <span className="flex items-center gap-2 text-xs/4 text-muted-foreground">
                  <StateMark tone={targetStateTone(selected)} />
                  <span className="truncate">
                    {names.environment === undefined ? "" : `${names.environment} · `}{targetStateLabel(selected)}
                  </span>
                </span>
              </span>
              <ChevronsUpDown aria-hidden="true" className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side={isMobile ? "bottom" : "right"}
            align="start"
            className="w-(--radix-dropdown-menu-trigger-width) min-w-72 md:w-96"
          >
            {environmentGroups(targets).map((group, index) => (
              <Fragment key={group.id}>
                {index > 0 && <DropdownMenuSeparator />}
                <DropdownMenuGroup aria-labelledby={group.label === undefined ? undefined : `${groupId}-${index}`}>
                  {group.label !== undefined && (
                    <DropdownMenuLabel id={`${groupId}-${index}`} className="text-xs/4 font-medium break-words text-muted-foreground">
                      {group.label}
                    </DropdownMenuLabel>
                  )}
                  {group.targets.map((target) => {
                    const detail = itemDetail(target);
                    return (
                      <DropdownMenuItem
                        key={target.id}
                        aria-current={target.id === selected.id ? "true" : undefined}
                        onSelect={() => {
                          if (target.id !== selected.id) navigate({ targetId: target.id });
                        }}
                        className="items-start gap-2"
                      >
                        <span className="mt-0.5"><StateMark tone={targetStateTone(target)} /></span>
                        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                          <span className="text-sm/5 font-medium break-words">{environmentNames(target).environment ?? target.label}</span>
                          {detail !== "" && <span className="text-[13px]/[18px] break-words text-muted-foreground">{detail}</span>}
                        </span>
                        {target.id === selected.id && <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
              </Fragment>
            ))}
            <DropdownMenuSeparator />
            <div className="flex justify-between gap-4 px-2 py-1.5 text-[13px]/[18px]">
              <span className="text-muted-foreground">Refreshed</span>
              <span>{formatRelativeTime(selected.refreshedAt)}</span>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
