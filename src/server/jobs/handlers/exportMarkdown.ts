/**
 * Markdown export handler.
 *
 * Writes `INDEX.md` and the daily notes into OBSIDIAN_VAULT_PATH when one is
 * configured. Off by default: the archive is the source of truth, and the
 * vault is a mirror for people who want one.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildMarkdownVault } from "../../export/markdown";
import { getEnv } from "../../env";

export interface ExportPayload {
  userId: string;
}

export async function handleExportMarkdown(payload: ExportPayload): Promise<void> {
  const vault = getEnv().OBSIDIAN_VAULT_PATH.trim();
  if (!vault) return;

  const files = await buildMarkdownVault({ userId: payload.userId });
  await mkdir(vault, { recursive: true });

  for (const [name, content] of Object.entries(files)) {
    // Names come from our own code (INDEX.md, YYYY-MM-DD.md); refuse anything
    // that could escape the vault directory anyway.
    if (name.includes("/") || name.includes("\\") || name.startsWith(".")) continue;
    await writeFile(join(vault, name), content, "utf8");
  }

  console.log(`[export] wrote ${Object.keys(files).length} markdown files to ${vault}`);
}
