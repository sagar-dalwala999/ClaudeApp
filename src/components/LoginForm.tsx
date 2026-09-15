"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { login, type LoginState } from "@/app/login/actions";

const INITIAL: LoginState = { error: null };

export function LoginForm() {
  const [state, action] = useActionState(login, INITIAL);

  return (
    <form className="login-form" action={action}>
      <label>
        Email
        <input name="email" type="email" autoComplete="username" required autoFocus spellCheck={false} />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="current-password" required minLength={8} />
      </label>
      {state.error && <p className="login-error">{state.error}</p>}
      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="hint primary" disabled={pending}>
      {pending ? "Signing in…" : "Sign in"}
    </button>
  );
}
