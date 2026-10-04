import { useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { DEFAULT_PREFERENCES, type Preferences, type Theme } from "../preferences.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { McpConnection } from "./McpConnection.tsx";
import { useReturnFocus } from "./useReturnFocus.ts";

export function SettingsDialog({ open, onOpenChange, opener, preferences, onChange, saved, authenticated = false }: {
  open: boolean;
  /** The element that gets focus back when the dialog closes; empty means the one focused when it opened. */
  opener: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  preferences: Preferences;
  onChange: (changes: Partial<Preferences>) => void;
  saved: boolean;
  /** Whether this Gauntlet requires authentication, which MCP clients then need too. */
  authenticated?: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const returnFocus = useReturnFocus(opener);
  const motionId = useId();
  const navigationId = useId();
  const [tab, setTab] = useState("appearance");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-[600px]"
        {...returnFocus}
      >
        <DialogHeader className="p-4 pr-12 text-left sm:p-6 sm:pr-12">
          <DialogTitle className="text-xl/7 font-semibold">Settings</DialogTitle>
          <DialogDescription className="text-sm/5">Appearance and connection settings for Gauntlet.</DialogDescription>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(next) => {
            setTab(next);
            if (bodyRef.current) bodyRef.current.scrollTop = 0;
          }}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="px-4 sm:px-6">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="appearance" className="text-sm/5">Appearance</TabsTrigger>
              <TabsTrigger value="mcp" className="text-sm/5">MCP</TabsTrigger>
            </TabsList>
          </div>
          <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
            <TabsContent value="appearance" className="flex flex-col gap-6">
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <p className="text-sm/5 font-medium">Theme</p>
                  <p className="text-[13px]/[18px] text-muted-foreground">Choose how Gauntlet looks.</p>
                </div>
                <RadioGroup
                  aria-label="Theme"
                  value={preferences.theme}
                  onValueChange={(theme) => onChange({ theme: theme as Theme })}
                  className="grid-cols-3 gap-2 sm:gap-4"
                >
                  <ThemeOption value="light" label="Light" selected={preferences.theme === "light"}>
                    <div className="flex flex-col gap-2 rounded-md bg-[#fafafa] p-2">
                      <div className="flex flex-col gap-2 rounded-md border border-[#ebebeb] bg-white p-2">
                        <div className="h-2 w-4/5 rounded-sm bg-[#ebebeb]" />
                        <div className="h-2 w-3/5 rounded-sm bg-[#ebebeb]" />
                      </div>
                      <div className="flex items-center gap-2 rounded-md border border-[#ebebeb] bg-white p-2">
                        <div className="size-3 rounded-sm bg-[#171717]" />
                        <div className="h-2 w-[70%] rounded-sm bg-[#ebebeb]" />
                      </div>
                    </div>
                  </ThemeOption>
                  <ThemeOption value="dark" label="Dark" selected={preferences.theme === "dark"}>
                    <div className="flex flex-col gap-2 rounded-md bg-[#111111] p-2">
                      <div className="flex flex-col gap-2 rounded-md border border-[#242424] bg-[#0a0a0a] p-2">
                        <div className="h-2 w-4/5 rounded-sm bg-[#3d3d3d]" />
                        <div className="h-2 w-3/5 rounded-sm bg-[#3d3d3d]" />
                      </div>
                      <div className="flex items-center gap-2 rounded-md border border-[#242424] bg-[#0a0a0a] p-2">
                        <div className="size-3 rounded-sm bg-[#ededed]" />
                        <div className="h-2 w-[70%] rounded-sm bg-[#3d3d3d]" />
                      </div>
                    </div>
                  </ThemeOption>
                  <ThemeOption value="system" label="System" selected={preferences.theme === "system"}>
                    <div className="grid grid-cols-2 overflow-hidden rounded-md">
                      <div className="flex flex-col gap-2 bg-[#fafafa] p-2 pr-0">
                        <div className="flex flex-col gap-2 rounded-l-md border border-r-0 border-[#ebebeb] bg-white p-2 pr-0">
                          <div className="h-2 w-full bg-[#ebebeb]" />
                          <div className="h-2 w-4/5 bg-[#ebebeb]" />
                        </div>
                        <div className="flex items-center gap-2 rounded-l-md border border-r-0 border-[#ebebeb] bg-white p-2">
                          <div className="size-3 rounded-sm bg-[#171717]" />
                        </div>
                      </div>
                      <div className="flex flex-col gap-2 bg-[#111111] p-2 pl-0">
                        <div className="flex flex-col gap-2 rounded-r-md border border-l-0 border-[#242424] bg-[#0a0a0a] p-2 pl-0">
                          <div className="h-2 w-4/5 bg-[#3d3d3d]" />
                          <div className="h-2 w-2/5 bg-[#3d3d3d]" />
                        </div>
                        <div className="flex items-center gap-2 rounded-r-md border border-l-0 border-[#242424] bg-[#0a0a0a] p-2 pl-0">
                          <div className="h-2 w-[70%] bg-[#3d3d3d]" />
                        </div>
                      </div>
                    </div>
                  </ThemeOption>
                </RadioGroup>
              </div>

              <div className="flex flex-col gap-4 border-t pt-4">
                <SwitchRow
                  id={motionId}
                  label="Reduce motion"
                  description="A calmer interface, without animated transitions and indicators."
                  checked={preferences.reducedMotion}
                  onCheckedChange={(reducedMotion) => onChange({ reducedMotion })}
                />
                <SwitchRow
                  id={navigationId}
                  label="Collapsed navigation"
                  description="More room for content on desktop. You can expand it at any time."
                  checked={preferences.sidebarCollapsed}
                  onCheckedChange={(sidebarCollapsed) => onChange({ sidebarCollapsed })}
                />
              </div>

              <p role="status" className={`text-[13px]/[18px] ${saved ? "text-muted-foreground" : "text-warn"}`}>
                {saved
                  ? "Preferences are saved automatically in this browser."
                  : "Could not save preferences. Changes apply until you reload this tab."}
              </p>
            </TabsContent>
            {/* Kept mounted so the address being edited survives a switch to Appearance and back. */}
            <TabsContent value="mcp" forceMount className="data-[state=inactive]:hidden">
              <McpConnection authenticated={authenticated} />
            </TabsContent>
          </div>
        </Tabs>
        <DialogFooter className="flex-row items-center justify-between gap-2 border-t px-4 py-4 sm:justify-between sm:px-6">
          {tab === "appearance"
            ? <Button type="button" variant="ghost" onClick={() => onChange(DEFAULT_PREFERENCES)}>Restore defaults</Button>
            : <span />}
          <Button type="button" onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ThemeOption({ value, label, selected, children }: {
  value: Theme;
  label: string;
  selected: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Label
      htmlFor={id}
      className="flex-col items-stretch gap-2 text-sm/5 font-medium"
    >
      <div
        aria-hidden="true"
        className={`rounded-lg border-2 p-1 ${selected ? "border-primary" : "border-border hover:border-input"}`}
      >
        {children}
      </div>
      <span className="flex items-center gap-2">
        <RadioGroupItem id={id} value={value} />
        {label}
      </span>
    </Label>
  );
}

function SwitchRow({ id, label, description, checked, onCheckedChange }: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const descriptionId = `${id}-description`;
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="flex flex-col gap-1">
        <Label htmlFor={id} className="text-sm/5">{label}</Label>
        <p id={descriptionId} className="text-[13px]/[18px] text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} aria-describedby={descriptionId} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
