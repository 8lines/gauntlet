import { useRef } from "react";

/**
 * Props for a Radix `DialogContent` that is opened from outside (no `DialogTrigger`): Radix would
 * hand focus back to a trigger that does not exist, so the element focused before the dialog
 * opened gets it back instead.
 */
export function useReturnFocus() {
  const previous = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      if (previous.current?.isConnected) previous.current.focus({ preventScroll: true });
      previous.current = null;
    },
  };
}
