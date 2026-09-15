import { LogOut, Settings } from "lucide-react";
import type { Principal } from "../lib/types";

export function AccountFooter({
  principal,
  onLogout,
  logoutDisabled,
}: {
  principal: Principal;
  onLogout: () => void;
  logoutDisabled: boolean;
}) {
  const initials = principal.displayName
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <footer className="profile-row">
      <span className="profile-avatar">{initials}</span>
      <span className="profile-copy">
        <strong>{principal.displayName}</strong>
        <small>{principal.organizationName}</small>
      </span>
      <span className="profile-actions">
        {principal.administrator ? (
          <a
            className="icon-button"
            href="/"
            title="Open Control Center"
            aria-label="Open Control Center"
          >
            <Settings size={15} aria-hidden="true" />
          </a>
        ) : null}
        <button
          className="icon-button"
          type="button"
          disabled={logoutDisabled}
          onClick={onLogout}
          title="Sign out"
          aria-label="Sign out"
        >
          <LogOut size={15} aria-hidden="true" />
        </button>
      </span>
    </footer>
  );
}
