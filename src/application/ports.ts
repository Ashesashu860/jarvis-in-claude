/**
 * The ports: interfaces the core owns and the adapters implement. Nothing in here knows about
 * the Agent SDK, sockets or files, and SDK types never cross this line.
 */
import type { ModelChoice } from "../domain/intents.js";
import type { TurnId } from "../domain/turn-state.js";

// ---------------------------------------------------------------- speech in / out
export type InputEvent =
  | { kind: "speechStart"; at: number }
  | { kind: "utterance"; text: string; speechMs: number; sttMs: number }
  | { kind: "bargeIn"; at: number };

/** Where the user's words come from: the mic engine, the keyboard, a test fake. */
export interface SpeechInput {
  /** Ends when the input closes (EOF, engine shut down) or `signal` aborts. */
  events(signal: AbortSignal): AsyncIterable<InputEvent>;
}

export type PlaybackEvent =
  | { kind: "firstAudio"; turnId: TurnId; at: number }
  | { kind: "done"; turnId: TurnId; at: number };

/** Where Jarvis's words go: the voice engine, the console, a test fake. */
export interface SpeechOutput {
  /** Queue one piece of a reply. Never blocks the turn. */
  say(text: string, turnId: TurnId): void;
  /** No more pieces will follow for this turn; `done` fires once the last one has played. */
  endTurn(turnId: TurnId): void;
  /** Speak a one-off line outside any turn ("Very good, sir."). */
  announce(text: string): void;
  /** Stop speaking now and drop what's queued. */
  hush(): void;
  playback(signal: AbortSignal): AsyncIterable<PlaybackEvent>;
}

// ---------------------------------------------------------------- the brain
export type AgentEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "done"; sessionId: string; ttftMs?: number }
  | { kind: "interrupted" }
  | { kind: "error"; message: string; retryable: boolean };

/** What every turn needs. */
export interface AgentBrain {
  /** One turn. Ends after `done`, `interrupted` or `error`, or when `signal` aborts. */
  send(text: string, signal: AbortSignal): AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
}

/** Rarely used controls, kept apart from AgentBrain (interface segregation). */
export interface AgentControl {
  setModel(model: ModelChoice): Promise<void>;
  setPermissionMode(mode: "plan" | "default"): Promise<void>;
  newSession(): Promise<void>;
  close(): Promise<void>;
}

/** Implemented by the core, called by the brain adapter when a tool needs permission. */
export interface PermissionDecider {
  decide(request: { tool: string; summary: string }, signal: AbortSignal):
    Promise<{ allow: true } | { allow: false; reason: string }>;
}

// ---------------------------------------------------------------- storage, telemetry, time
export interface SessionStore {
  last(): Promise<string | null>;
  save(sessionId: string): Promise<void>;
  clear(): Promise<void>;
}

export interface TurnTimings {
  readonly turnId: TurnId;
  readonly heard: string;
  readonly outcome: "done" | "interrupted" | "error";
  readonly startedAt: string; // ISO wall time
  readonly speechMs?: number;
  readonly sttMs?: number;
  readonly firstTextMs?: number; // from sending the prompt
  readonly firstSentenceMs?: number;
  readonly firstAudioMs?: number;
  readonly totalMs?: number;
}

export interface TimingSink {
  record(timings: TurnTimings): void;
}

export interface Clock {
  /** Monotonic milliseconds. */
  now(): number;
  /** Wall time, for logs. */
  wall(): Date;
}
