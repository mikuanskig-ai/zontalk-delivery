"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /**
   * When set, the confirm button stays disabled until the admin types
   * this exact value into a field below the description — extra
   * friction reserved for actions a plain yes/no is too easy to
   * click through (e.g. deleting a company wipes every conversation,
   * contact and order it has, with no undo).
   */
  typedConfirmValue?: string;
  /** Label above the typed-confirmation field. Defaults to a generic prompt naming the value. */
  typedConfirmLabel?: string;
}

/**
 * Drop-in async replacement for `window.confirm()` — same call shape
 * (`if (!(await confirm(...))) return`), but renders the app's own
 * styled Dialog instead of the native browser prompt. Render
 * `{dialog}` once anywhere in the component's JSX tree.
 */
export function useConfirmDialog() {
  const t = useTranslations("Common");
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [typedValue, setTypedValue] = useState("");
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    setOptions(opts);
    setTypedValue("");
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    setOpen(false);
    resolveRef.current?.(result);
    resolveRef.current = null;
  }, []);

  const typedConfirmBlocked =
    !!options?.typedConfirmValue && typedValue !== options.typedConfirmValue;

  const dialog = (
    <Dialog open={open} onOpenChange={(next) => { if (!next) settle(false); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{options?.title}</DialogTitle>
          {options?.description && (
            <DialogDescription>{options.description}</DialogDescription>
          )}
        </DialogHeader>
        {options?.typedConfirmValue && (
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">
              {options.typedConfirmLabel ?? t("typedConfirmLabel", { value: options.typedConfirmValue })}
            </label>
            <Input
              value={typedValue}
              onChange={(e) => setTypedValue(e.target.value)}
              autoFocus
              autoComplete="off"
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => settle(false)}>
            {options?.cancelLabel ?? t("cancel")}
          </Button>
          <Button
            variant={options?.destructive ? "destructive" : "default"}
            disabled={typedConfirmBlocked}
            onClick={() => settle(true)}
          >
            {options?.confirmLabel ?? t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirm, dialog };
}
