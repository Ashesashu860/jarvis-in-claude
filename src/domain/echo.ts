/**
 * Did the microphone hear Jarvis or the user? Echo cancellation removes some of the played voice,
 * but what slips through transcribes as Jarvis's own recent words (often slightly garbled). So we
 * compare what was heard with what he has just said, forgiving small recognition errors.
 */
const words = (text: string): string[] =>
  text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter((w) => w.length > 0);

/** Edit distance, capped: we only care whether it's 0, 1 or "more". */
function closeEnough(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4) return false; // short words must match exactly
  if (a.startsWith(b) || b.startsWith(a)) return true; // "configur" / "configuration"
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** The heard words that aren't (near enough) anything Jarvis just said. */
export function foreignWords(heard: string, recentlySpoken: string): string[] {
  const said = [...new Set(words(recentlySpoken))];
  return words(heard).filter((w) => !said.some((s) => closeEnough(w, s)));
}

/** A finished transcript that is mostly Jarvis's recent words. */
export function isEcho(heard: string, recentlySpoken: string, threshold = 0.7): boolean {
  const h = words(heard);
  if (h.length === 0 || words(recentlySpoken).length === 0) return false;
  const matched = h.length - foreignWords(heard, recentlySpoken).length;
  return matched / h.length >= threshold;
}

/** Words that, said over Jarvis, are surely the user wanting him to stop. */
const STOP_WORDS = new Set(["stop", "wait", "hold", "hang", "pause", "jarvis", "enough", "quiet", "shush", "cancel"]);

export type CutInRule = "stopWord" | "anySpeech";

/**
 * Is speech heard over Jarvis the user cutting in?
 * - "stopWord" (loudspeakers, where his echo comes back garbled into new-looking words): only a
 *   stop word he didn't just say counts.
 * - "anySpeech" (headphones: no echo): also a fair share (`share`) of words he didn't say.
 */
export function isCuttingIn(heard: string, recentlySpoken: string, rule: CutInRule = "stopWord", share = 0.34): boolean {
  const h = words(heard);
  if (h.length === 0) return false;
  const foreign = foreignWords(heard, recentlySpoken);
  if (foreign.some((w) => STOP_WORDS.has(w))) return true;
  if (rule === "stopWord") return false;
  const distinct = new Set(foreign).size; // a recogniser stuck on "bill bill bill" is one word
  return distinct >= 2 && foreign.length / h.length >= share;
}
