import Link from "next/link";
import { SystemPanel } from "@/components/SystemPanel";
import { LOGOUT_HREF } from "@/components/LogoutLink";
import { requireUser } from "@/server/auth/guard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Settings · Looks" };

export default async function SettingsPage() {
  const user = await requireUser();

  return (
    <main className="settings-page">
      <header className="settings-head">
        <h1>Settings</h1>
        <p className="hint-text">
          Signed in as <code>{user.email}</code>
        </p>
        <nav>
          <Link className="hint" href="/">
            ← back to the wall
          </Link>
          <a className="hint" href={LOGOUT_HREF}>
            sign out
          </a>
        </nav>
      </header>
      <SystemPanel />
    </main>
  );
}
