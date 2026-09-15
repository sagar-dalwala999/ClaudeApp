/**
 * GET /api/events — server-sent events.
 *
 * The wall updates itself while the worker fetches: a paste turns into a card
 * with a real picture and a written summary without a refresh.
 *
 * The stream is closed after a few minutes and EventSource reconnects, which
 * keeps a dead connection from holding a database connection forever.
 */
import { itemsUpdatedSince } from "@/server/db/queries/items";
import { handle, requireApiUser } from "@/server/http/respond";

export const dynamic = "force-dynamic";

const POLL_MS = 2500;
const MAX_LIFETIME_MS = 5 * 60 * 1000;

export const GET = handle(async ({ req }) => {
  const user = await requireApiUser();
  const encoder = new TextEncoder();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let since = new Date();
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      send("hello", { at: since.toISOString() });

      const schedulePoll = () => {
        if (!closed) timer = setTimeout(() => void poll(), POLL_MS);
      };

      const poll = async () => {
        if (closed) return;
        try {
          const changed = await itemsUpdatedSince(user.id, since);
          if (changed.length) {
            send("items", { items: changed });
            since = new Date(changed[changed.length - 1].updatedAt);
          }
        } catch (err) {
          // A transient database error must not kill the stream or advance its
          // cursor past updates that have not been delivered.
          console.warn(`[events] poll failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          schedulePoll();
        }
      };

      schedulePoll();

      const shutdown = (reason: string) => {
        if (closed) return;
        try {
          send("bye", { reason });
          closed = true;
          clearTimeout(timer);
          controller.close();
        } catch {
          closed = true;
          clearTimeout(timer);
          /* already closed */
        }
      };

      // Cap the connection lifetime; the browser reconnects automatically.
      const lifetime = setTimeout(() => shutdown("rotate"), MAX_LIFETIME_MS);
      req.signal.addEventListener("abort", () => {
        clearTimeout(lifetime);
        shutdown("client-closed");
      });
      // Don't let the stream keep the process alive on shutdown.
      if (typeof lifetime === "object") (lifetime as { unref?: () => void }).unref?.();
    },
    cancel() {
      closed = true;
      clearTimeout(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
});
