import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

const query = "(max-width: 820px)";
function subscribe(onChange: () => void) {
  const media = window.matchMedia?.(query);
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}
const isMobile = () => window.matchMedia?.(query).matches ?? false;
export const useMobileNavigation = () => useSyncExternalStore(subscribe, isMobile, () => false);

export function NavigationPanel({
  open,
  onClose,
  onClosed,
  collapsed = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onClosed?: () => void;
  collapsed?: boolean;
  children: ReactNode;
}) {
  const mobile = useMobileNavigation();
  const dialog = useRef<HTMLDialogElement>(null);
  const closed = useRef(onClosed);
  closed.current = onClosed;
  useEffect(() => {
    const element = dialog.current;
    if (!element || !open) return;
    element.showModal();
    return () => {
      element.close();
      closed.current?.();
    };
  }, [open, mobile]);

  if (!mobile)
    return (
      <aside className="sidebar" aria-label="Workspace navigation" data-collapsed={collapsed}>
        {children}
      </aside>
    );
  return (
    <dialog
      ref={dialog}
      className="sidebar"
      aria-label="Workspace navigation"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        )].filter((item) => item.getClientRects().length > 0);
        const first = items[0];
        const last = items.at(-1);
        if (!first || !last) {
          event.preventDefault();
          event.currentTarget.focus();
        } else if (event.shiftKey && (document.activeElement === first ||
          !event.currentTarget.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last ||
          !event.currentTarget.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
    >
      {children}
    </dialog>
  );
}
