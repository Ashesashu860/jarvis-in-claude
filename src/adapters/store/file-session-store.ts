import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { SessionStore } from "../../application/ports.js";

const FileShape = z.record(z.string(), z.object({ sessionId: z.string(), savedAt: z.string() }));

/** The last session per working directory, so `jarvis-rt` in a repo picks up where it left off. */
export class FileSessionStore implements SessionStore {
  constructor(private readonly path: string, private readonly cwd: string) {}

  async last(): Promise<string | null> {
    return (await this.readAll())[this.cwd]?.sessionId ?? null;
  }

  async save(sessionId: string): Promise<void> {
    const all = await this.readAll();
    all[this.cwd] = { sessionId, savedAt: new Date().toISOString() };
    await this.writeAll(all);
  }

  async clear(): Promise<void> {
    const all = await this.readAll();
    await this.writeAll(Object.fromEntries(Object.entries(all).filter(([dir]) => dir !== this.cwd)));
  }

  private async readAll(): Promise<z.infer<typeof FileShape>> {
    try {
      const parsed = FileShape.safeParse(JSON.parse(await readFile(this.path, "utf8")));
      return parsed.success ? parsed.data : {};
    } catch {
      return {}; // missing or unreadable: start fresh
    }
  }

  private async writeAll(data: z.infer<typeof FileShape>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(tmp, this.path); // atomic: never a half-written file
  }
}
