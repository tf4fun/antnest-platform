import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

const query = "(max-width: 820px)";
function subscribe(onChange: () => void) {
  const media = window.matchMedia?.(query);
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}
const isMobile = () => window.matchMedia?.(query).matches ?? false;

export function NavigationPanel({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const mobile = useSyncExternalStore(subscribe, isMobile, () => false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element || !open) return;
    element.showModal();
    return () => element.close();
  }, [open, mobile]);

  if (!mobile)
    return (
      <aside className="sidebar" aria-label="Workspace navigation">
        {children}
      </aside>
    );
  return (
    <dialog
      ref={dialog}
      className="sidebar"
      aria-label="Workspace navigation"
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
