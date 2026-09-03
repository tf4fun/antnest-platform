import { KeyRound, LoaderCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../lib/api";
import { passwordChangeError } from "../lib/forms";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { ErrorNotice, SuccessNotice } from "./ui/feedback";
import { Field, Input } from "./ui/input";

export function AccountSecurity({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);

  function close() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmation("");
    setPending(false);
    setError("");
    setChanged(false);
    onOpenChange(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = passwordChangeError(currentPassword, newPassword, confirmation);
    if (validationError) {
      setError(validationError);
      return;
    }
    setPending(true);
    setError("");
    try {
      await api.changeOwnPassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setChanged(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      dismissible={!pending}
      open={open}
      onOpenChange={(next) => { if (!next) close(); }}
      title="Local password"
      description="Company sign-in passwords remain with the identity provider."
    >
      {changed ? (
        <div className="grid gap-5">
          <SuccessNotice message="Your password has been updated." />
          <div className="flex justify-end">
            <Button type="button" onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          {error ? <ErrorNotice message={error} /> : null}
          <Field label="Current password">
            <Input
              autoComplete="current-password"
              autoFocus
              disabled={pending}
              required
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </Field>
          <Field label="New password" hint="At least 12 bytes.">
            <Input
              autoComplete="new-password"
              disabled={pending}
              required
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </Field>
          <Field label="Confirm new password">
            <Input
              autoComplete="new-password"
              disabled={pending}
              required
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" disabled={pending} onClick={close}>Cancel</Button>
            <Button aria-busy={pending} disabled={pending} type="submit">
              {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              {pending ? "Updating" : "Update password"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
