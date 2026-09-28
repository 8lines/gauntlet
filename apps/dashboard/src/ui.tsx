import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon.tsx";
import type { Tone } from "./copy.ts";

/** Primitives following shadcn/ui conventions — same names and tokens, no dependency. */

const TONE_CLASSES: Readonly<Record<Tone, string>> = {
  ok: "bg-ok-bg text-ok ring-ok-bd",
  wait: "bg-wait-bg text-wait ring-wait-bd",
  stop: "bg-stop-bg text-stop ring-stop-bd",
  info: "bg-info-bg text-info ring-info-bd",
  sub: "bg-muted text-muted-foreground ring-border",
};

/** Compact semantic badges shared by navigation, forms and results. */
export function Badge({ tone = "sub", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 break-all rounded-badge px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}

/** Activity indicator. Pulses only while a run is in progress. */
export function ActivityIndicator({ blinking = true, className = "" }: { blinking?: boolean; className?: string }) {
  return <span className={`${blinking ? "activity-dot" : "activity-dot-static"} ${className}`} aria-hidden="true" />;
}

type ButtonVariant = "primary" | "secondary" | "destructive";

export function Button(
  { variant = "secondary", className = "", ...rest }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant },
) {
  const variants: Record<ButtonVariant, string> = {
    primary: "border-primary bg-primary text-primary-foreground shadow-control hover:bg-primary/90",
    secondary: "border-input bg-background shadow-control hover:bg-accent",
    destructive: "border-destructive bg-destructive text-white hover:bg-destructive/90",
  };
  return (
    <button
      {...rest}
      className={`ui-button inline-flex items-center justify-center gap-2 rounded-control border px-4 py-2 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${variants[variant]} ${className}`}
    />
  );
}

export function Card({ title, action, icon, children }: { title?: string; action?: ReactNode; icon?: IconName; children: ReactNode }) {
  return (
    <section className="surface-card min-w-0 overflow-hidden">
      {title !== undefined && (
        <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
          {icon !== undefined && <Icon name={icon} className="h-4 w-4 text-muted-foreground" />}
          <h2 className="min-w-0 text-[14px] font-semibold tracking-tight">{title}</h2>
          <span className="flex-1" />
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatTiles({ items }: { items: readonly { readonly value: string; readonly label: string; readonly tone?: Tone }[] }) {
  const toneClass: Readonly<Record<Tone, string>> = {
    ok: "text-ok", wait: "text-wait", stop: "text-stop", info: "text-info", sub: "text-muted-foreground",
  };
  return (
    <div className="surface-card grid grid-cols-2 gap-px overflow-hidden bg-border sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="bg-background px-4 py-3.5">
          <p className={`text-[24px] font-semibold tracking-tight tabular-nums ${item.tone === undefined ? "" : toneClass[item.tone]}`}>{item.value}</p>
          <p className="mt-1 text-[12px] text-muted-foreground">{item.label}</p>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-5 py-12 text-center">
      <span className="empty-icon mb-3"><Icon name="inbox" className="h-6 w-6" /></span>
      <p className="text-[14px] font-medium">{title}</p>
      <p className="max-w-sm text-[12px] leading-relaxed text-muted-foreground">{description}</p>
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Rows({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border">{children}</div>;
}

const TONE_ICONS: Readonly<Record<Tone, readonly [string, IconName]>> = {
  ok: ["text-ok", "check"], wait: ["text-wait", "warning"], stop: ["text-stop", "warning"],
  info: ["text-info", "shield"], sub: ["text-muted-foreground", "clock"],
};

export function EffectList({ items }: { items: readonly { readonly tone: Tone; readonly text: string }[] }) {
  return (
    <ul className="space-y-2.5">
      {items.map((item) => {
        const [className, icon] = TONE_ICONS[item.tone];
        return (
          <li key={item.text} className="flex gap-3 text-[13px] leading-relaxed">
            <Icon name={icon} className={`mt-0.5 h-4 w-4 ${className}`} />
            <span className={item.tone === "sub" ? "text-muted-foreground" : undefined}>{item.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Confirmation gate for operations the adapter marked
 * `execution.confirmationRequired`. It lists effects, not settings —
 * the decision is based on what will happen, not on what is ticked.
 */
export function ConfirmDialog(
  { title, destructive, cta, onCancel, onConfirm, children }: {
    title: string;
    destructive: boolean;
    cta: string;
    onCancel: () => void;
    onConfirm: () => void;
    children: ReactNode;
  },
) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useLayoutEffect(() => {
    const root = document.querySelector<HTMLElement>("#root");
    const previousAriaHidden = root?.getAttribute("aria-hidden") ?? null;
    const previousInert = root?.inert ?? false;
    const dialog = dialogRef.current;

    if (root !== null) {
      root.inert = true;
      root.setAttribute("aria-hidden", "true");
    }

    const initialFocus = dialog?.querySelector<HTMLElement>("[data-dialog-primary]") ?? dialog;
    initialFocus?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelRef.current();
        return;
      }
      if (event.key !== "Tab" || dialog === null) return;

      const elements = focusableElements(dialog);
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = elements[0]!;
      const last = elements[elements.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (root !== null) {
        root.inert = previousInert;
        if (previousAriaHidden === null) root.removeAttribute("aria-hidden");
        else root.setAttribute("aria-hidden", previousAriaHidden);
      }
      const element = previousFocus.current;
      if (element?.isConnected === true && !element.matches(":disabled")) {
        element.focus({ preventScroll: true });
      }
    };
  }, []);

  return createPortal(
    <div className="modal-backdrop fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center" onClick={onCancel}>
      <div
        ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="dialog-surface flex w-full max-w-md flex-col"
      >
        <div className={`shrink-0 px-5 py-4 ${destructive ? "bg-stop-bg" : ""}`}>
          {destructive && <p className="section-label mb-2 text-stop">cannot be undone</p>}
          <h2 className={`text-[15px] font-semibold tracking-tight ${destructive ? "text-stop" : ""}`}>{title}</h2>
        </div>
        <div data-dialog-content className="min-h-0 overflow-y-auto border-y border-border px-5 py-4">{children}</div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2 px-5 py-4">
          <Button onClick={onCancel}>Cancel</Button>
          <Button className="max-w-full" data-dialog-primary variant={destructive ? "destructive" : "primary"} onClick={onConfirm}>{cta}</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
}
