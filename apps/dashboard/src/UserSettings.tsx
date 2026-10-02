import { useEffect, useId, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon.tsx";
import { Button } from "./ui.tsx";
import { McpConnectionSettings } from "./McpConnectionSettings.tsx";
import {
  DEFAULT_PREFERENCES,
  type Theme,
  type Preferences,
} from "./preferences.ts";

const THEMES: readonly { value: Theme; label: string; icon: IconName }[] = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "system", label: "System", icon: "monitor" },
];

/** Opened from the sidebar's Settings button (`open`) until the settings dialog replaces it. */
export function UserSettings({
  open,
  onClose,
  preferences,
  onChange,
  saved,
}: {
  open: boolean;
  onClose: () => void;
  preferences: Preferences;
  onChange: (changes: Partial<Preferences>) => void;
  saved: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const themeName = useId();
  const [section, setSection] = useState<"appearance" | "mcp">("appearance");
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog !== null && !dialog.open) dialog.showModal();
    else if (!open && dialog?.open) dialog.close();
  }, [open]);

  const selectSection = (next: "appearance" | "mcp") => {
    setSection(next);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  };

  return (
    <>
      <dialog
        ref={dialogRef}
        className="dialog-surface settings-dialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClose={onClose}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialogRef.current?.close();
        }}
      >
        <div className="flex min-h-0 flex-col">
          <div className="settings-header flex shrink-0 items-start gap-3 border-b border-border p-5 sm:p-6">
            <span className="settings-header-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-accent text-info">
              <Icon name="user" />
            </span>
            <div className="min-w-0 flex-1">
              <h2
                id={titleId}
                className="text-[18px] font-semibold tracking-tight"
              >
                User settings
              </h2>
              <p
                id={descriptionId}
                className="settings-description mt-1 text-[13px] leading-relaxed text-muted-foreground"
              >
                Appearance and connection settings for Gauntlet.
              </p>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Close settings"
              onClick={() => dialogRef.current?.close()}
            >
              <Icon name="close" />
            </button>
          </div>
          <div role="group" aria-label="Settings sections" className="flex shrink-0 gap-1 border-b border-border px-5 py-2 sm:px-6">
            <button
              type="button"
              aria-pressed={section === "appearance"}
              onClick={() => selectSection("appearance")}
              className="settings-section-button"
            >
              Appearance
            </button>
            <button
              type="button"
              aria-pressed={section === "mcp"}
              onClick={() => selectSection("mcp")}
              className="settings-section-button"
            >
              MCP
            </button>
          </div>
          <div ref={contentRef} className="min-h-0 space-y-7 overflow-y-auto p-5 sm:p-6">
            <div hidden={section !== "appearance"} className="space-y-7">
              <fieldset>
                <legend className="text-[14px] font-semibold">Theme</legend>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  Choose how the dashboard looks, or match your system.
                </p>
                <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-3">
                  {THEMES.map((theme) => (
                    <label key={theme.value} className="relative cursor-pointer">
                      <input
                        type="radio"
                        name={themeName}
                        value={theme.value}
                        aria-label={theme.label}
                        checked={preferences.theme === theme.value}
                        onChange={() => onChange({ theme: theme.value })}
                        className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0"
                      />
                      <span className="flex flex-col gap-3 rounded-card border border-border p-2.5 transition-colors peer-checked:border-primary peer-checked:bg-accent/40 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background sm:p-3">
                        <span
                          className="theme-preview"
                          data-preview={theme.value}
                          aria-hidden="true"
                        >
                          <span />
                          <span>
                            <i />
                            <i />
                            <i />
                          </span>
                        </span>
                        <span className="flex items-center justify-center gap-1.5 text-[11px] font-medium min-[360px]:text-[12px] sm:text-[13px]">
                          <Icon name={theme.icon} className="hidden h-3.5 w-3.5 min-[360px]:block" />
                          {theme.label}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <section aria-label="Interface preferences">
                <h3 className="mb-2 text-[14px] font-semibold">Interface</h3>
                <div className="divide-y divide-border">
                  <Toggle
                    label="Reduce motion"
                    description="A calmer interface, without animated transitions and indicators."
                    checked={preferences.reducedMotion}
                    onChange={(reducedMotion) => onChange({ reducedMotion })}
                  />
                  <Toggle
                    label="Collapsed navigation"
                    description="More room for content on desktop. You can expand it at any time."
                    checked={preferences.sidebarCollapsed}
                    onChange={(sidebarCollapsed) =>
                      onChange({ sidebarCollapsed })
                    }
                  />
                </div>
              </section>
              <p
                role="status"
                className={`rounded-control px-3 py-2.5 text-[12px] leading-relaxed ${saved ? "bg-muted text-muted-foreground" : "bg-wait-bg text-wait"}`}
              >
                {saved
                  ? "Preferences are saved automatically in this browser."
                  : "Could not save preferences. Changes apply until you reload this tab."}
              </p>
            </div>
            <div hidden={section !== "mcp"}>
              <McpConnectionSettings />
            </div>
          </div>
          <div className={`settings-footer flex shrink-0 flex-wrap items-center gap-3 border-t border-border px-5 py-4 sm:px-6 ${section === "appearance" ? "justify-between" : "justify-end"}`}>
            {section === "appearance" && (
              <button
                type="button"
                onClick={() => onChange(DEFAULT_PREFERENCES)}
                className="min-h-11 rounded-control text-[12px] text-muted-foreground hover:text-foreground"
              >
                Restore defaults
              </button>
            )}
            <Button
              variant="primary"
              onClick={() => dialogRef.current?.close()}
            >
              Done
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const descriptionId = useId();
  return (
    <label className="flex min-h-16 cursor-pointer items-center gap-4 py-4">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{label}</span>
        <span
          id={descriptionId}
          className="mt-1 block text-[12px] leading-relaxed text-muted-foreground"
        >
          {description}
        </span>
      </span>
      <span className="relative flex min-h-11 items-center">
        <input
          type="checkbox"
          role="switch"
          aria-label={label}
          aria-describedby={descriptionId}
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0"
        />
        <span
          aria-hidden="true"
          data-checked={checked}
          className="switch-track peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background"
        >
          <span className="switch-thumb" />
        </span>
      </span>
    </label>
  );
}
