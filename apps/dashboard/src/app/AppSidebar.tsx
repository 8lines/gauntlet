import { useId, type RefObject } from "react";
import { Settings } from "lucide-react";
import type { OperationSummary } from "@8lines/gauntlet-protocol";
import type { TargetSnapshot } from "../api.ts";
import { navigate, type Route } from "../route.ts";
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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { EnvironmentSwitcher } from "./EnvironmentSwitcher.tsx";

export function AppSidebar({ targets, selected, route, onOpenSettings, navigationToggle }: {
  targets: readonly TargetSnapshot[] | undefined;
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
  const features = [...(manifest?.features ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const groups = features
    .map((feature) => ({
      id: feature.id,
      label: feature.label,
      operations: manifest?.operations.filter((operation) => operation.featureId === feature.id) ?? [],
    }));
  const ungrouped = manifest?.operations.filter((operation) => !features.some((feature) => feature.id === operation.featureId)) ?? [];
  if (ungrouped.length > 0) groups.push({ id: "other", label: "Other", operations: ungrouped });

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
        {selected !== undefined && groups.map((group) => (
          group.operations.length === 0 ? null : (
            <OperationGroup
              key={group.id}
              label={group.label}
              operations={group.operations}
              targetId={selected.id}
              activeId={route.operationId}
              onSelect={closeOnMobile}
            />
          )
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
        </SidebarMenu>
        <p className="px-2 py-1 font-mono text-xs/4 text-muted-foreground">Gauntlet v{__GAUNTLET_VERSION__}</p>
      </SidebarFooter>
    </Sidebar>
  );
}

function OperationGroup({ label, operations, targetId, activeId, onSelect }: {
  label: string;
  operations: readonly OperationSummary[];
  targetId: string;
  activeId: string | undefined;
  onSelect: () => void;
}) {
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
                  className={available ? "text-sm/5" : "pr-24 text-sm/5"}
                  onClick={() => {
                    navigate({ targetId, operationId: operation.id });
                    onSelect();
                  }}
                >
                  <span>{operation.label}</span>
                </SidebarMenuButton>
                {!available && <SidebarMenuBadge className="text-xs/4 text-muted-foreground">Unavailable</SidebarMenuBadge>}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
