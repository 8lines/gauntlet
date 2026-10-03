import { Fragment, useEffect, useRef, type RefObject } from "react";
import { Search } from "lucide-react";
import { navigate, routePath, type Route } from "../route.ts";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";

export interface BreadcrumbEntry {
  readonly label: string;
  readonly route?: Route;
}

export function AppHeader({ breadcrumb, onSearch, triggerRef }: {
  breadcrumb: readonly BreadcrumbEntry[];
  onSearch: () => void;
  /** The navigation toggle, shared so other dialogs can hand focus back to it. */
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { isMobile, open, openMobile } = useSidebar();
  const wasOpen = useRef(false);
  useEffect(() => {
    // The mobile sheet is not opened by a Radix trigger, so it does not hand focus back by itself.
    // Focus that already moved on to another dialog (Settings opened from the sheet) stays there.
    if (wasOpen.current && !openMobile) {
      const focused = document.activeElement;
      const leftInSheet = focused === null || focused === document.body || focused.closest('[data-sidebar="sidebar"]') !== null;
      if (leftInSheet) triggerRef.current?.focus({ preventScroll: true });
    }
    wasOpen.current = openMobile;
  }, [openMobile, triggerRef]);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
      <SidebarTrigger
        ref={triggerRef}
        aria-label="Toggle navigation"
        aria-expanded={isMobile ? openMobile : open}
        // On mobile the navigation is a sheet that only exists while it is open, so there is nothing to point at.
        {...(isMobile ? {} : { "aria-controls": "gauntlet-navigation" })}
      />
      <Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />
      <Breadcrumb aria-label="Breadcrumb" className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap gap-2 text-sm/5 sm:gap-2">
          {breadcrumb.map((entry, index) => {
            const last = index === breadcrumb.length - 1;
            return (
              <Fragment key={`${index}:${entry.label}`}>
                {index > 0 && <BreadcrumbSeparator className="text-sm/5 max-sm:hidden">/</BreadcrumbSeparator>}
                <BreadcrumbItem className={last ? "min-w-0" : "min-w-0 max-sm:hidden"}>
                  {last ? (
                    <BreadcrumbPage className="truncate font-medium" title={entry.label}>{entry.label}</BreadcrumbPage>
                  ) : entry.route === undefined ? (
                    <span className="truncate" title={entry.label}>{entry.label}</span>
                  ) : (
                    <BreadcrumbLink
                      href={routePath(entry.route)}
                      title={entry.label}
                      className="truncate"
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(entry.route!);
                      }}
                    >
                      {entry.label}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
      <Button
        variant="outline"
        size="sm"
        aria-label="Search environments and operations"
        className="shrink-0 justify-between font-normal text-muted-foreground sm:w-64"
        onClick={onSearch}
      >
        <span className="flex items-center gap-2">
          <Search aria-hidden="true" className="size-4" />
          <span className="text-sm/5">Search</span>
        </span>
        <kbd className="hidden font-mono text-xs/4 sm:inline">⌘ K</kbd>
      </Button>
    </header>
  );
}
