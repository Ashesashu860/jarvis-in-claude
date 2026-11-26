/**
 * Runs the conversation: feeds events from the ports into the reducer and carries out the
 * commands it returns. All decisions live in the domain; this class only does the I/O.
 */
import { SentenceChunker } from "../domain/sentence-chunker.js";
import { createReducer, initialState, type Command, type Event, type Persona, type Reducer, type State, type TurnId } from "../domain/turn-state.js";
import { AsyncQueue } from "./async-queue.js";
import type { AgentBrain, AgentControl, Clock, SpeechInput, SpeechOutput, TimingSink, TurnTimings } from "./ports.js";

export interface ConversationDeps {
  readonly input: SpeechInput;
  readonly output: SpeechOutput;
  readonly brain: AgentBrain;
  readonly control: AgentControl;
  readonly timings: TimingSink;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly persona: Persona;
  readonly newChunker?: () => SentenceChunker;
}

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly abort: AbortController;
  readonly chunker: SentenceChunker;
}

/** What we learn about a turn as it runs; becomes a TurnTimings record when it ends. */
interface Metrics {
  heard: string;
  speechMs?: number;
  sttMs?: number;
  startedAt?: Date;
  sentAt?: number;
  firstText?: number;
  firstSentence?: number;
  firstAudio?: number;
  outcome: TurnTimings["outcome"];
}

function busyTurn(state: State): TurnId | null {
  return state.kind === "thinking" || state.kind === "speaking" ? state.turnId : null;
}

export class ConversationService {
  private state: State = initialState;
  private readonly events = new AsyncQueue<Event>();
  private readonly reduce: Reducer;
  private active: ActiveTurn | null = null;
  private readonly metrics = new Map<TurnId, Metrics>();
  private exiting = false;

  constructor(private readonly deps: ConversationDeps) {
    this.reduce = createReducer(deps.persona);
  }

  get currentState(): State {
    return this.state;
  }

  /** Feed an event in from outside (e.g. Ctrl+C as a barge-in). */
  dispatch(event: Event): void {
    this.events.push(event);
  }

  async run(signal: AbortSignal): Promise<void> {
    const stop = new AbortController();
    const onAbort = () => this.events.close();
    signal.addEventListener("abort", onAbort, { once: true });
    void this.pumpInput(stop.signal);
    void this.pumpPlayback(stop.signal);
    try {
      for await (const event of this.events) {
        const before = busyTurn(this.state);
        const [next, commands] = this.reduce(this.state, event);
        this.state = next;
        for (const command of commands) await this.execute(command);
        if (before && busyTurn(this.state) !== before) this.finishMetrics(before);
        if (this.exiting) break;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.active?.abort.abort();
      stop.abort();
      await this.deps.control.close();
    }
  }

  // ------------------------------------------------------------------ event sources
  private async pumpInput(signal: AbortSignal): Promise<void> {
    try {
      for await (const ev of this.deps.input.events(signal)) {
        if (ev.kind === "utterance") {
          const turnId = this.deps.newId();
          this.metrics.set(turnId, { heard: ev.text, speechMs: ev.speechMs, sttMs: ev.sttMs, outcome: "done" });
          this.events.push({ kind: "utterance", text: ev.text, turnId });
        } else if (ev.kind === "bargeIn") {
          this.events.push({ kind: "bargeIn" });
        }
      }
    } finally {
      this.events.push({ kind: "inputClosed" });
    }
  }

  private async pumpPlayback(signal: AbortSignal): Promise<void> {
    for await (const ev of this.deps.output.playback(signal)) {
      if (ev.kind === "firstAudio") {
        const m = this.metrics.get(ev.turnId);
        if (m && m.firstAudio === undefined) m.firstAudio = ev.at;
      } else {
        this.events.push({ kind: "playbackDone", turnId: ev.turnId });
      }
    }
  }

  // ------------------------------------------------------------------ commands
  private async execute(command: Command): Promise<void> {
    const { output, brain, control } = this.deps;
    switch (command.kind) {
      case "send":
        this.startTurn(command.turnId, command.text);
        return;
      case "say":
        output.say(command.text, command.turnId);
        return;
      case "endTurn":
        output.endTurn(command.turnId);
        return;
      case "hush":
        output.hush();
        return;
      case "interrupt": {
        const turn = this.active;
        if (turn?.turnId !== command.turnId) return;
        turn.abort.abort();
        turn.chunker.reset(); // text already received must not be spoken
        this.active = null;
        const m = this.metrics.get(command.turnId);
        if (m) m.outcome = "interrupted";
        await brain.interrupt();
        return;
      }
      case "acknowledge":
        output.announce(command.text);
        return;
      case "newSession":
        await control.newSession();
        return;
      case "setModel":
        await control.setModel(command.model);
        return;
      case "setPermissionMode":
        await control.setPermissionMode(command.mode);
        return;
      case "exit":
        this.exiting = true;
        return;
      default: {
        const unreachable: never = command;
        return unreachable;
      }
    }
  }

  private startTurn(turnId: TurnId, text: string): void {
    const turn: ActiveTurn = {
      turnId,
      abort: new AbortController(),
      chunker: this.deps.newChunker?.() ?? new SentenceChunker(),
    };
    this.active = turn;
    const m = this.metrics.get(turnId) ?? { heard: text, outcome: "done" as const };
    m.startedAt = this.deps.clock.wall();
    m.sentAt = this.deps.clock.now();
    this.metrics.set(turnId, m);
    void this.streamTurn(turn, text, m);
  }

  private async streamTurn(turn: ActiveTurn, text: string, m: Metrics): Promise<void> {
    const { clock } = this.deps;
    const sentence = (piece: string) => {
      m.firstSentence ??= clock.now();
      this.events.push({ kind: "sentence", turnId: turn.turnId, text: piece });
    };
    try {
      for await (const ev of this.deps.brain.send(text, turn.abort.signal)) {
        if (turn.abort.signal.aborted) return;
        switch (ev.kind) {
          case "text":
            m.firstText ??= clock.now();
            turn.chunker.push(ev.delta).forEach(sentence);
            break;
          case "tool":
            break; // spoken narration arrives in M5
          case "done":
            turn.chunker.flush().forEach(sentence);
            this.events.push({ kind: "replyDone", turnId: turn.turnId });
            return;
          case "interrupted":
            m.outcome = "interrupted";
            this.events.push({ kind: "replyDone", turnId: turn.turnId });
            return;
          case "error":
            m.outcome = "error";
            this.events.push({ kind: "replyFailed", turnId: turn.turnId, message: ev.message });
            return;
        }
      }
    } catch (err) {
      if (turn.abort.signal.aborted) return;
      m.outcome = "error";
      this.events.push({ kind: "replyFailed", turnId: turn.turnId, message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (this.active === turn) this.active = null;
    }
  }

  private finishMetrics(turnId: TurnId): void {
    const m = this.metrics.get(turnId);
    this.metrics.delete(turnId);
    if (!m?.startedAt || m.sentAt === undefined) return;
    const sentAt = m.sentAt;
    const since = (t: number) => Math.round(t - sentAt);
    const record: TurnTimings = {
      turnId,
      heard: m.heard,
      outcome: m.outcome,
      startedAt: m.startedAt.toISOString(),
      ...(m.speechMs !== undefined && { speechMs: m.speechMs }),
      ...(m.sttMs !== undefined && { sttMs: m.sttMs }),
      ...(m.firstText !== undefined && { firstTextMs: since(m.firstText) }),
      ...(m.firstSentence !== undefined && { firstSentenceMs: since(m.firstSentence) }),
      ...(m.firstAudio !== undefined && { firstAudioMs: since(m.firstAudio) }),
      totalMs: since(this.deps.clock.now()),
    };
    this.deps.timings.record(record);
  }
}
