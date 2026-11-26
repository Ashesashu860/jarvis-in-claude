/**
 * The conversation as a pure reducer: (state, event) -> [state, commands].
 * It decides; the application layer carries out the commands against the ports.
 *
 * Rules:
 * - Talking over Jarvis (`bargeIn`) cuts the current reply off: hush the voice, interrupt Claude.
 * - A prompt that arrives while a reply is running (typed ahead) waits its turn, as in Claude Code.
 *   Commands ("stop", "new conversation", "use opus") act at once.
 * - Events for a turn that is no longer current (a late delta after an interrupt) are ignored.
 * - While Jarvis waits on "Shall I…?", what the user says is the answer. "Stop" (or anything that
 *   cuts the reply off) is a no; something that isn't an answer gets the question again, briefly.
 */
import { parseAnswer, parseIntent, type Answer, type ModelChoice } from "./intents.js";

export type TurnId = string;
export interface Pending { readonly turnId: TurnId; readonly text: string }

/** A permission question waiting for the user's answer. */
export interface Question { readonly id: string; readonly text: string }

interface Busy {
  readonly turnId: TurnId;
  readonly queue: readonly Pending[];
  readonly exitAfter: boolean;
  readonly asking: Question | null;
}

export type State =
  | { kind: "idle" }
  | { kind: "listening" }
  | ({ kind: "thinking" } & Busy)
  | ({ kind: "speaking"; replyDone: boolean } & Busy);

export type Event =
  | { kind: "wake" }
  | { kind: "utterance"; text: string; turnId: TurnId }
  | { kind: "bargeIn" }
  | { kind: "sentence"; turnId: TurnId; text: string }
  | { kind: "replyDone"; turnId: TurnId }
  | { kind: "replyFailed"; turnId: TurnId; message: string }
  | { kind: "playbackDone"; turnId: TurnId }
  | { kind: "permissionAsked"; turnId: TurnId; question: Question }
  | { kind: "permissionTimedOut"; turnId: TurnId; id: string }
  | { kind: "inputClosed" };

export type Command =
  | { kind: "send"; turnId: TurnId; text: string }
  | { kind: "say"; turnId: TurnId; text: string }
  | { kind: "endTurn"; turnId: TurnId }
  | { kind: "hush" }
  | { kind: "interrupt"; turnId: TurnId }
  | { kind: "acknowledge"; text: string }
  | { kind: "answer"; id: string; answer: Answer }
  | { kind: "newSession" }
  | { kind: "setModel"; model: ModelChoice }
  | { kind: "setPermissionMode"; mode: "plan" | "default" }
  | { kind: "exit" };

export interface Persona { readonly address: string }

export const initialState: State = { kind: "listening" };

type Result = readonly [State, readonly Command[]];

const LISTENING: State = { kind: "listening" };

function isBusy(state: State): state is Extract<State, Busy> {
  return state.kind === "thinking" || state.kind === "speaking";
}

/** Start a reply to `next`. */
function begin(next: Pending, queue: readonly Pending[], exitAfter: boolean): Result {
  return [{ kind: "thinking", turnId: next.turnId, queue, exitAfter, asking: null },
    [{ kind: "send", turnId: next.turnId, text: next.text }]];
}

/** The current reply is over: start the next queued prompt, exit, or listen. */
function finish(state: Extract<State, Busy>, extra: readonly Command[] = []): Result {
  const [next, ...rest] = state.queue;
  if (next) {
    const [s, cmds] = begin(next, rest, state.exitAfter);
    return [s, [...extra, ...cmds]];
  }
  if (state.exitAfter) return [{ kind: "idle" }, [...extra, { kind: "exit" }]];
  return [LISTENING, extra];
}

export function createReducer(persona: Persona) {
  const sir = persona.address;

  function cutOff(state: State): Command[] {
    if (!isBusy(state)) return [];
    const refuse: Command[] = state.asking ? [{ kind: "answer", id: state.asking.id, answer: "no" }] : [];
    return [...refuse, { kind: "hush" }, { kind: "interrupt", turnId: state.turnId }];
  }

  /** What the user said while Jarvis waits on "Shall I…?". */
  function onAnswer(state: Extract<State, Busy>, question: Question, text: string): Result | null {
    const answer = parseAnswer(text);
    if (answer) return [{ ...state, asking: null }, [{ kind: "answer", id: question.id, answer }]];
    if (parseIntent(text).kind !== "prompt") return null; // a command: handled as usual (and refuses)
    return [state, [{ kind: "say", turnId: state.turnId, text: `Sorry, ${sir}: yes or no?` }]];
  }

  function onUtterance(state: State, text: string, turnId: TurnId): Result {
    if (isBusy(state) && state.asking) {
      const answered = onAnswer(state, state.asking, text);
      if (answered) return answered;
    }
    const intent = parseIntent(text);
    const stop = cutOff(state);
    switch (intent.kind) {
      case "prompt":
        if (isBusy(state)) return [{ ...state, queue: [...state.queue, { turnId, text: intent.text }] }, []];
        return begin({ turnId, text: intent.text }, [], false);
      case "pause":
        return [LISTENING, stop];
      case "newConversation":
        return [LISTENING, [...stop, { kind: "newSession" }, { kind: "acknowledge", text: `Of course, ${sir}. Starting afresh.` }]];
      case "goodbye":
        return [{ kind: "idle" }, [...stop, { kind: "acknowledge", text: `Very good, ${sir}.` }, { kind: "exit" }]];
      case "useModel":
        return [LISTENING, [...stop, { kind: "setModel", model: intent.model },
          { kind: "acknowledge", text: `Switching to ${intent.model}, ${sir}.` }]];
      case "permissionMode":
        return [LISTENING, [...stop, { kind: "setPermissionMode", mode: intent.mode }, {
          kind: "acknowledge",
          text: intent.mode === "plan" ? `Plan mode, ${sir}. I'll propose before I change anything.` : `Back to normal mode, ${sir}.`,
        }]];
      default: {
        const unreachable: never = intent;
        return unreachable;
      }
    }
  }

  return function reduce(state: State, event: Event): Result {
    switch (event.kind) {
      case "wake":
        return state.kind === "idle" ? [LISTENING, []] : [state, []];
      case "utterance":
        return state.kind === "idle" ? [state, []] : onUtterance(state, event.text, event.turnId);
      case "bargeIn":
        return isBusy(state) ? [LISTENING, cutOff(state)] : [state, []];
      case "inputClosed":
        if (isBusy(state)) return [{ ...state, exitAfter: true }, []]; // let the reply finish
        return [{ kind: "idle" }, [{ kind: "exit" }]];
    }
    // The remaining events belong to a turn: ignore them unless it's the current one.
    if (!isBusy(state) || event.turnId !== state.turnId) return [state, []];
    switch (event.kind) {
      case "sentence":
        return [{ ...state, kind: "speaking", replyDone: false }, [{ kind: "say", turnId: event.turnId, text: event.text }]];
      case "replyDone":
        if (state.kind === "thinking") return finish(state); // the reply had nothing to say aloud
        return [{ ...state, replyDone: true }, [{ kind: "endTurn", turnId: event.turnId }]];
      case "replyFailed":
        return finish(state, [{ kind: "hush" }, { kind: "acknowledge", text: `I'm afraid something went wrong, ${sir}: ${event.message}` }]);
      case "playbackDone":
        return state.kind === "speaking" && state.replyDone ? finish(state) : [state, []];
      case "permissionAsked":
        return [{ ...state, kind: "speaking", replyDone: false, asking: event.question },
          [{ kind: "say", turnId: event.turnId, text: event.question.text }]];
      case "permissionTimedOut":
        if (state.asking?.id !== event.id) return [state, []];
        return [{ ...state, asking: null }, [{ kind: "answer", id: event.id, answer: "no" },
          { kind: "say", turnId: event.turnId, text: `I'll take that as a no, ${sir}.` }]];
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  };
}

export type Reducer = ReturnType<typeof createReducer>;
