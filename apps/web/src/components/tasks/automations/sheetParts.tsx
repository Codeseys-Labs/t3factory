import { useState, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { Label } from "../../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../../ui/sheet";

/** The right-hand sheet of E2 and E3: a header, a scrolling body and a footer with its actions. */
export function AutomationSheet({
  title,
  description,
  onClose,
  footer,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetPopup className="sm:max-w-130">
        <div className="border-b">
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
            {description ? <SheetDescription>{description}</SheetDescription> : null}
          </SheetHeader>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4 text-sm">{children}</div>
        {footer ? <div className="flex items-center gap-2 border-t px-6 py-4">{footer}</div> : null}
      </SheetPopup>
    </Sheet>
  );
}

/** Cancel and the primary action, pushed to the end of the footer. */
export function SheetActions({
  saveLabel,
  canSave,
  onCancel,
  onSave,
}: {
  saveLabel: string;
  canSave: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="ms-auto flex gap-2">
      <Button variant="outline" onClick={onCancel}>
        Cancel
      </Button>
      <Button disabled={!canSave} onClick={onSave}>
        {saveLabel}
      </Button>
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

export function SelectField<V extends string>({
  label,
  value,
  items,
  onChange,
  hint,
  disabled = false,
}: {
  label: string;
  value: V;
  items: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue>{items.find((item) => item.value === value)?.label}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </Field>
  );
}

export function SheetSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="font-medium text-sm">{title}</h3>
      {children}
    </section>
  );
}

/** A quiet destructive action that asks first and says what else it touches. */
export function DeleteAction({
  label,
  title,
  consequence,
  disabled,
  onConfirm,
}: {
  label: string;
  title: string;
  consequence: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost-destructive"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{consequence}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** What happened to the last save: a refusal, or that someone else changed the item. */
export function SheetNotice({ error, changed }: { error: string | null; changed: string | null }) {
  return (
    <>
      {changed ? (
        <p role="status" className="text-warning-foreground">
          {changed}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** A link that names an item that is no longer on this machine. */
export function MissingSheet({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <AutomationSheet title={title} onClose={onClose}>
      <p className="text-muted-foreground">It was deleted on this machine.</p>
    </AutomationSheet>
  );
}
