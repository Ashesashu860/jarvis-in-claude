/**
 * The jarvis-voice speech daemon's protocol: one JSON object per line over a Unix socket.
 * See jarvis-voice `src/jarvis_voice/daemon.py` for the server side.
 */
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const PlaybackEventSchema = z.object({
  event: z.enum(["start", "end"]),
  tag: z.string(),
  at: z.number(),
  dropped: z.boolean().optional(),
});
export type EnginePlaybackEvent = z.infer<typeof PlaybackEventSchema>;

export type EngineRequest =
  | { op: "say"; text: string; session: string; append: true; tag: string }
  | { op: "hush"; session: string }
  | { op: "warm"; stt: boolean }
  | { op: "status" };

/** Where the daemon listens: the same rules jarvis-voice uses for its cache folder. */
export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const cache = env.JARVIS_VOICE_CACHE ?? join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "jarvis-voice");
  return join(cache, "speechd.sock");
}

/** Send one request and resolve with the first line of the reply. Rejects if nobody answers. */
export function requestOnce(path: string, request: EngineRequest, timeoutMs = 1000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("speech daemon timed out")); }, timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify(request)}\n`));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      sock.end();
      try { resolve(JSON.parse(buf.slice(0, nl))); } catch { reject(new Error("speech daemon sent invalid JSON")); }
    });
    sock.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Open the long-lived `subscribe` connection; `onEvent` gets each valid playback event. */
export function subscribe(path: string, onEvent: (ev: EnginePlaybackEvent) => void, onClose: () => void): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    let buf = "";
    let open = false;
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify({ op: "subscribe" })}\n`));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!open) { open = true; resolve(sock); continue; } // the {"ok": true} greeting
        let raw: unknown;
        try { raw = JSON.parse(line); } catch { continue; }
        const parsed = PlaybackEventSchema.safeParse(raw);
        if (parsed.success) onEvent(parsed.data); // anything else is ignored, never trusted
      }
    });
    sock.on("error", (err) => { if (!open) reject(err); });
    sock.on("close", () => { if (open) onClose(); });
  });
}
