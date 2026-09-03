import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  trigger,
  dismissible = true,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  trigger?: ReactNode;
  dismissible?: boolean;
  children: ReactNode;
}) {
  function changeOpen(next: boolean) {
    if (next || dismissible) onOpenChange(next);
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={changeOpen}>
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-slate-950/40 backdrop-blur-[1px]" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-50 max-h-[88vh] w-[min(580px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-2xl outline-none"
          onEscapeKeyDown={(event) => { if (!dismissible) event.preventDefault(); }}
          onInteractOutside={(event) => { if (!dismissible) event.preventDefault(); }}
        >
          <div className="mb-5 pr-10">
            <DialogPrimitive.Title className="text-lg font-semibold">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>
          {children}
          <DialogPrimitive.Close asChild>
            <Button
              aria-label="Close dialog"
              className="absolute right-3 top-3"
              disabled={!dismissible}
              size="icon"
              title={dismissible ? "Close" : "Wait for the current operation to finish"}
              variant="ghost"
            >
              <X className="h-4 w-4" />
            </Button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
