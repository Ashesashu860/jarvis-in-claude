/**
 * SpeechOutput through the jarvis-voice speech daemon, which keeps the Kokoro voice loaded.
 *
 * Each piece of a reply is sent as its own `say` with a tag; the daemon joins it to the reply
 * already playing (so the next sentence renders while this one plays) and reports, over a
 * `subscribe` connection, when each tag starts and finishes. A turn is "done" once the core has
 * said it's over (`endTurn`) and every one of its tags has finished or been dropped.
 *
 * Failure policy: speech is never allowed to hang the conversation. If the daemon can't be
 * reached, or the subscription drops, outstanding pieces count as dropped.
 */
import { spawn } from "node:child_process";
import type { Socket } from "node:net";
import { AsyncQueue } from "../../application/async-queue.js";
import type { Clock, PlaybackEvent, SpeechOutput } from "../../application/ports.js";
import type { TurnId } from "../../domain/turn-state.js";
import { requestOnce, subscribe, type EnginePlaybackEvent, type EngineRequest } from "./engine-protocol.js";

export interface EngineOutputOptions {
  readonly socketPath: string;
  readonly clock: Clock;
  /** The daemon's session name: speech from other sessions (Claude Code windows) waits its turn. */
  readonly session?: string;
  /** Command that starts the daemon when it isn't running. */
  readonly startCommand?: readonly string[];
  /** How long to keep trying to reach a daemon we just started. */
  readonly startTimeoutMs?: number;
  readonly onWarning?: (message: string) => void;
}

interface TurnPlayback {
  readonly outstanding: Set<string>;
  ended: boolean;
  started: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class JarvisEngineOutput implements SpeechOutput {
  private readonly events = new AsyncQueue<PlaybackEvent>();
  private readonly turns = new Map<TurnId, TurnPlayback>();
  private readonly tagTurn = new Map<string, TurnId>();
  private seq = 0;
  private chain: Promise<void> = Promise.resolve(); // requests go one at a time, in order
  private sub: Socket | null = null;
  private subscribing: Promise<void> | null = null;
  private warned = false;
  private readonly session: string;

  constructor(private readonly opts: EngineOutputOptions) {
    this.session = opts.session ?? "jarvis-rt";
  }

  /** Start the daemon if needed and have it load the voice now, before the first reply. */
  prepare(): void {
    this.send({ op: "warm", stt: false }, () => undefined);
  }

  say(text: string, turnId: TurnId): void {
    const tag = `${turnId}#${this.seq++}`;
    const turn = this.turn(turnId);
    turn.outstanding.add(tag);
    this.tagTurn.set(tag, turnId);
    this.send({ op: "say", text, session: this.session, append: true, tag }, () => this.finishTag(tag));
  }

  endTurn(turnId: TurnId): void {
    const turn = this.turn(turnId);
    turn.ended = true;
    // Queue the check behind pending sends, so a turn isn't "done" before its last say is sent.
    this.chain = this.chain.then(() => this.maybeDone(turnId));
  }

  announce(text: string): void {
    this.send({ op: "say", text, session: this.session, append: true, tag: `announce#${this.seq++}` }, () => undefined);
  }

  hush(): void {
    this.turns.clear();
    this.tagTurn.clear();
    this.send({ op: "hush", session: this.session }, () => undefined);
  }

  async *playback(signal: AbortSignal): AsyncIterable<PlaybackEvent> {
    signal.addEventListener("abort", () => { this.events.close(); this.sub?.destroy(); }, { once: true });
    yield* this.events;
  }

  // ------------------------------------------------------------------ internals
  private turn(turnId: TurnId): TurnPlayback {
    let t = this.turns.get(turnId);
    if (!t) {
      t = { outstanding: new Set(), ended: false, started: false };
      this.turns.set(turnId, t);
    }
    return t;
  }

  private send(request: EngineRequest, onFailure: () => void): void {
    this.chain = this.chain.then(async () => {
      try {
        await this.ensureSubscribed();
        await requestOnce(this.opts.socketPath, request);
      } catch (err) {
        this.warn(`Voice unavailable (${err instanceof Error ? err.message : String(err)}); showing text only.`);
        onFailure();
      }
    });
  }

  /** Subscribe before the first say, starting the daemon if needed. */
  private async ensureSubscribed(): Promise<void> {
    if (this.sub) return;
    this.subscribing ??= this.connect().finally(() => { this.subscribing = null; });
    await this.subscribing;
  }

  private async connect(): Promise<void> {
    const attach = async () => {
      this.sub = await subscribe(this.opts.socketPath, (ev) => this.onEngineEvent(ev), () => this.onSubscriptionLost());
    };
    try {
      await attach();
      return;
    } catch {
      this.startDaemon();
    }
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 10_000);
    for (;;) {
      await sleep(100);
      try {
        await attach();
        return;
      } catch (err) {
        if (Date.now() > deadline) throw err;
      }
    }
  }

  private startDaemon(): void {
    const [cmd, ...args] = this.opts.startCommand ?? ["jarvis", "daemon"];
    if (!cmd) return;
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
      child.on("error", () => undefined); // reported as "unavailable" when the connect times out
      child.unref();
    } catch {
      // same: the connect loop reports it
    }
  }

  private onEngineEvent(ev: EnginePlaybackEvent): void {
    const turnId = this.tagTurn.get(ev.tag);
    if (!turnId) return; // an announcement, or a turn already hushed
    const turn = this.turns.get(turnId);
    if (!turn) return;
    if (ev.event === "start") {
      if (!turn.started) {
        turn.started = true;
        this.events.push({ kind: "firstAudio", turnId, at: this.opts.clock.now() });
      }
      return;
    }
    this.finishTag(ev.tag);
  }

  private finishTag(tag: string): void {
    const turnId = this.tagTurn.get(tag);
    this.tagTurn.delete(tag);
    if (!turnId) return;
    this.turns.get(turnId)?.outstanding.delete(tag);
    this.maybeDone(turnId);
  }

  private maybeDone(turnId: TurnId): void {
    const turn = this.turns.get(turnId);
    if (!turn?.ended || turn.outstanding.size > 0) return;
    this.turns.delete(turnId);
    this.events.push({ kind: "done", turnId, at: this.opts.clock.now() });
  }

  /** The daemon went away mid-reply: nothing outstanding will play, so don't wait for it. */
  private onSubscriptionLost(): void {
    this.sub = null;
    for (const tag of [...this.tagTurn.keys()]) this.finishTag(tag);
  }

  private warn(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.opts.onWarning?.(message);
  }
}
