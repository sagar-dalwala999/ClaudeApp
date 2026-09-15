import { redirect } from "next/navigation";
import { getAuthUser } from "@/server/auth/guard";
import { pingDb } from "@/server/db/client";
import { LoginForm } from "@/components/LoginForm";

export const dynamic = "force-dynamic";

export const metadata = { title: "Sign in · Looks" };

export default async function LoginPage() {
  if (await getAuthUser()) redirect("/");

  // A first-run instance with no database should say so plainly rather than
  // throwing a stack trace at whoever is trying to sign in.
  const dbUp = await pingDb().catch(() => false);

  return (
    <main className="login-page">
      <div className="login-card">
        <h1>Looks</h1>
        <p className="login-lede">
          Paste a link. It gets fetched, summarised and filed, and the wall keeps it findable.
        </p>
        {dbUp ? (
          <LoginForm />
        ) : (
          <div className="login-setup">
            <p className="login-error">The database is unreachable.</p>
            <ol>
              <li>
                Start Postgres: <code>docker compose up -d postgres</code>
              </li>
              <li>
                Apply migrations: <code>npm run db:migrate</code>
              </li>
              <li>
                Create your account: <code>npm run user:create -- you@example.com</code>
              </li>
            </ol>
          </div>
        )}
      </div>
    </main>
  );
}
