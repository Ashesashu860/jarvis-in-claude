/**
 * A small stand-in for the jarvis-voice speech daemon on a real Unix socket: the same JSON-lines
 * protocol (say / hush / status / subscribe), "playing" each tagged piece for `pieceMs`.
 */
import { mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class FakeEngine {
  readonly path = join(mkdtempSync(join(tmpdir(), "jre-")), "s.sock");
  readonly said: { text: string; tag: string }[] = [];
  hushes = 0;
  private readonly subscribers = new Set<Socket>();
  private queue: { text: string; tag: string }[] = [];
  private playing = false;
  private server: Server | null = null;

  constructor(private readonly pieceMs = 5) {}

  async start(): Promise<void> {
    this.server = createServer((sock) => {
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const req = JSON.parse(buf.slice(0, nl)) as { op: string; text?: string; tag?: string };
        buf = "";
        this.handle(req, sock);
      });
      sock.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => this.server?.listen(this.path, resolve));
  }

  async stop(): Promise<void> {
    for (const s of this.subscribers) s.destroy();
    await new Promise<void>((resolve) => { if (this.server) this.server.close(() => resolve()); else resolve(); });
  }

  private handle(req: { op: string; text?: string; tag?: string }, sock: Socket): void {
    switch (req.op) {
      case "subscribe":
        this.subscribers.add(sock);
        sock.write('{"ok": true}\n');
        sock.on("close", () => this.subscribers.delete(sock));
        return;
      case "say":
        this.said.push({ text: req.text ?? "", tag: req.tag ?? "" });
        this.queue.push({ text: req.text ?? "", tag: req.tag ?? "" });
        void this.play();
        break;
      case "hush":
        this.hushes++;
        for (const item of this.queue) this.emit({ event: "end", tag: item.tag, dropped: true });
        this.queue = [];
        break;
    }
    sock.end('{"ok": true}\n');
  }

  private async play(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    while (this.queue.length) {
      const item = this.queue[0];
      if (!item) break;
      this.emit({ event: "start", tag: item.tag });
      await new Promise((r) => setTimeout(r, this.pieceMs));
      if (this.queue[0] === item) {
        this.queue.shift();
        this.emit({ event: "end", tag: item.tag, dropped: false });
      }
    }
    this.playing = false;
  }

  private emit(ev: Record<string, unknown>): void {
    const line = `${JSON.stringify({ ...ev, at: Date.now() })}\n`;
    for (const s of this.subscribers) s.write(line);
  }
}
