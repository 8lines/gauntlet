import { useId, type RefObject } from "react";
import { LogOut, Pin, PinOff, Settings } from "lucide-react";
import type { OperationSummary } from "@8lines/gauntlet-protocol";
import type { TargetSnapshot } from "../api.ts";
import type { AuthPrincipal } from "../auth.ts";
import { navigate, type Route } from "../route.ts";
import type { Pins } from "../usePins.ts";
import { cn } from "@/lib/utils";
import { GauntletMark } from "@/components/gauntlet/GauntletMark";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EnvironmentSwitcher } from "./EnvironmentSwitcher.tsx";
import { sidebarGroups } from "./sidebar-groups.ts";

export function AppSidebar({ targets, selected, route, pins, onOpenSettings, navigationToggle, principal, onSignOut }: {
  targets: readonly TargetSnapshot[] | undefined;
  /** The selected target's pins; without loaded pins the sidebar has no Pinned group and no pin actions. */
  pins: Pins;
  /** The signed-in principal; undefined when authentication is off. */
  principal?: AuthPrincipal | undefined;
  onSignOut?: () => Promise<void>;
  selected: TargetSnapshot | undefined;
  route: Route;
  /** `opener` is the element that should get focus back when Settings closes. */
  onOpenSettings: (opener: HTMLElement | null) => void;
  navigationToggle: RefObject<HTMLElement | null>;
}) {
  const { isMobile, open, setOpenMobile } = useSidebar();
  const closeOnMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  // A collapsed desktop sidebar is only moved off screen: keep it out of the focus order.
  const hidden = !isMobile && !open;
  const manifest = selected?.manifest;
  const { pinned, groups } = sidebarGroups(manifest, pins.pinnedIds);

  return (
    <Sidebar
      id="gauntlet-navigation"
      collapsible="offcanvas"
      {...(hidden ? { inert: true, "aria-hidden": true } : {})}
    >
      <SidebarHeader className="gap-2 p-2">
        <div className="flex h-9 items-center gap-2 px-2">
          <GauntletMark className="size-5" />
          <span className="text-base/6 font-semibold">Gauntlet</span>
          <span className="font-mono text-[10px]/4 text-muted-foreground">v{__GAUNTLET_VERSION__}</span>
        </div>
        <EnvironmentSwitcher targets={targets} selected={selected} />
      </SidebarHeader>

      <SidebarContent role="navigation" aria-label="Operations">
        {selected !== undefined && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={route.operationId === undefined}
                    aria-current={route.operationId === undefined ? "page" : undefined}
                    className="pr-9 text-sm/5"
                    onClick={() => {
                      navigate({ targetId: selected.id });
                      closeOnMobile();
                    }}
                  >
                    <span>Overview</span>
                  </SidebarMenuButton>
                  <SidebarMenuBadge className="text-xs/4">{manifest?.operations.length ?? 0}</SidebarMenuBadge>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        {selected !== undefined && manifest === undefined && (
          <p className="px-4 text-[13px]/[18px] text-muted-foreground">
            No operation catalog. The environment did not respond correctly.
          </p>
        )}
        {selected !== undefined && pins.error !== undefined && (
          <p role="alert" className="px-4 text-[13px]/[18px] text-muted-foreground">{pins.error}</p>
        )}
        {selected !== undefined && pinned.length > 0 && (
          <OperationGroup
            label="Pinned"
            operations={pinned}
            targetId={selected.id}
            activeId={route.operationId}
            pins={pins}
            onSelect={closeOnMobile}
          />
        )}
        {selected !== undefined && groups.map((group) => (
          <OperationGroup
            key={group.id}
            label={group.label}
            operations={group.operations}
            targetId={selected.id}
            activeId={route.operationId}
            pins={pins}
            onSelect={closeOnMobile}
          />
        ))}
      </SidebarContent>

      <SidebarFooter className="gap-1 border-t p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="text-sm/5"
              onClick={(event) => {
                // The sheet is about to close with this button in it, so the toggle is what gets focus back.
                onOpenSettings(isMobile ? navigationToggle.current : event.currentTarget);
                closeOnMobile();
              }}
            >
              <Settings aria-hidden="true" className="text-muted-foreground" />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {principal !== undefined && onSignOut !== undefined && (
            <SidebarMenuItem>
              <SidebarMenuButton
                className="text-sm/5"
                onClick={() => {
                  closeOnMobile();
                  void onSignOut();
                }}
              >
                <LogOut aria-hidden="true" className="text-muted-foreground" />
                <span>Log out</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
        {principal !== undefined && (
          <p className="truncate px-2 pt-1 text-xs/4 text-muted-foreground">
            Signed in as <span className="text-foreground">{principal.displayName}</span>
          </p>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}

function OperationGroup({ label, operations, targetId, activeId, pins, onSelect }: {
  label: string;
  operations: readonly OperationSummary[];
  targetId: string;
  activeId: string | undefined;
  pins: Pins;
  onSelect: () => void;
}) {
  const pinnable = pins.pinnedIds !== undefined;
  const labelId = useId();
  return (
    <SidebarGroup>
      <SidebarGroupLabel id={labelId} className="text-xs/4">{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu aria-labelledby={labelId}>
          {operations.map((operation) => {
            const available = operation.availability.state === "available";
            return (
              <SidebarMenuItem key={operation.id}>
                <SidebarMenuButton
                  disabled={!available}
                  isActive={operation.id === activeId}
                  aria-current={operation.id === activeId ? "page" : undefined}
                  title={operation.label}
                  // The unavailable badge sits left of the pin action, so the label stops before both.
                  className={cn("text-sm/5", !available && (pinnable ? "group-has-data-[sidebar=menu-action]/menu-item:pr-28" : "pr-24"))}
                  onClick={() => {
                    navigate({ targetId, operationId: operation.id });
                    onSelect();
                  }}
                >
                  <span>{operation.label}</span>
                </SidebarMenuButton>
                {!available && (
                  <SidebarMenuBadge className={cn("text-xs/4 text-muted-foreground", pinnable && "right-7")}>Unavailable</SidebarMenuBadge>
                )}
                {pinnable && (
                  <PinAction label={operation.label} pinned={pins.isPinned(operation.id)} onToggle={() => pins.toggle(operation.id)} />
                )}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function PinAction({ label, pinned, onToggle }: { label: string; pinned: boolean; onToggle: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <SidebarMenuAction
          showOnHover
          aria-label={`${pinned ? "Unpin" : "Pin"} ${label}`}
          className="text-muted-foreground"
          onClick={onToggle}
        >
          {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
        </SidebarMenuAction>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={4}>{pinned ? "Unpin" : "Pin"}</TooltipContent>
    </Tooltip>
  );
}
