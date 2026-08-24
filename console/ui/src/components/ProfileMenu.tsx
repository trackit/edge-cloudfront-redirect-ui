import { useEffect, useRef, useState } from "react";
import { IconClose } from "./icons";
import { useAuth } from "../auth/useAuth";

/**
 * Who is signed in, and the way out.
 *
 * The role is shown rather than merely enforced: a viewer who cannot see why the
 * write controls are dead will read it as the console being broken. Naming it
 * here is what makes the disabled buttons legible.
 */
export default function ProfileMenu() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Same two dismissals as the distribution switcher next to it: a press
  // outside, and Escape putting focus back on the trigger.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const email = user?.email ?? "Signed in";
  const role = user?.groups.includes("editor")
    ? "Editor"
    : user?.groups.includes("viewer")
      ? "Viewer"
      : "No role assigned";

  return (
    <div className="profile" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="profile-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {/* The initial, not an avatar: there is no picture to show and a generic
            silhouette says less than the first letter of the address. */}
        <span className="profile-initial" aria-hidden="true">
          {email.slice(0, 1).toUpperCase()}
        </span>
        <span className="sr-only">Account for {email}</span>
      </button>

      {open && (
        <div className="profile-panel" role="menu">
          <div className="profile-who">
            <strong>{email}</strong>
            <span>{role}</span>
          </div>
          <button
            type="button"
            role="menuitem"
            className="profile-item"
            onClick={() => void signOut()}
          >
            <IconClose size={15} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
