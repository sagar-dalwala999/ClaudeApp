"use client";

/**
 * Sign-out as a form post to the server action.
 *
 * A plain link cannot invoke an action, and a client-side handler that calls
 * one still needs a form for progressive enhancement — so this is a form that
 * looks like a link.
 */
import { logout } from "@/app/login/actions";

/** Used by server components that only need a link-ish logout affordance. */
export const LOGOUT_HREF = "/login";

export function LogoutForm({ label = "sign out" }: { label?: string }) {
  return (
    <form action={logout} className="logout-form">
      <button type="submit" className="hint">
        {label}
      </button>
    </form>
  );
}
