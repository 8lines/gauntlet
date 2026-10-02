import { useRef, type RefObject } from "react";

/**
 * Props for a Radix `DialogContent` that is opened from outside (no `DialogTrigger`): Radix would
 * hand focus back to a trigger that does not exist, so another element gets it back instead.
 *
 * That is the element named by `opener` when the caller knows it (the mobile navigation sheet is
 * closing while the dialog opens, so the focused element at that moment is not stable), otherwise
 * the element focused before the dialog opened.
 */
export function useReturnFocus(opener?: RefObject<HTMLElement | null>) {
  const previous = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      const named = opener?.current ?? null;
      if (opener !== undefined) opener.current = null;
      previous.current = named ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      if (previous.current?.isConnected) previous.current.focus({ preventScroll: true });
      previous.current = null;
    },
  };
}
