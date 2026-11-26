/**
 * Turns Claude's markdown into text that sounds natural when spoken: "src/app/hooks.py:42" becomes
 * "hooks dot py, line 42", "speak_detached" becomes "speak detached", "v0.3.0" "version 0 point 3 point 0",
 * "60 ms" "60 milliseconds", and emoji are skipped rather than read out.
 *
 * Ported from jarvis-voice's text.py, rule for rule and in the same order, with its tests.
 */

// Common file extensions, spoken as "dot <ext>"; anything else keeps the plain dot.
const EXT = "py|pyc|js|jsx|ts|tsx|mjs|cjs|json|jsonl|md|txt|toml|yaml|yml|ini|cfg|lock|sh|zsh|" +
  "bash|html|css|scss|sql|go|rs|rb|java|kt|swift|c|h|cpp|hpp|cs|php|xml|csv|env|log|" +
  "wav|mp3|png|jpg|jpeg|gif|svg|pdf|dart|vue|svelte|lua|r|ipynb|onnx|bin|zip|gz|tar";
const FILE_SRC = String.raw`\b([\w-]+)\.(${EXT})\b(?::(\d+))?`;
const FILE = new RegExp(FILE_SRC, "gi");
const FILE_WHOLE = new RegExp(`^(?:${FILE_SRC})$`, "i");
// A path: two or more segments joined by "/" (optionally starting with ~/ ./ or /).
const PATH = /(?<![\w:/])((?:~|\.{1,2})?\/?)((?:[\w.@-]+\/)+)([\w.@-]+)/g;
const SLASH_CMD = /(?<![\w/])\/([a-z][\w-]*)(?::([\w-]+))?\b/g;
const VERSION = /\bv?(\d+(?:\.\d+){1,3})\b(?=(?:[^\d.]|\.\s|\.$|$))/g;
const UNITS: Readonly<Record<string, string>> = {
  ms: "milliseconds", s: "seconds", sec: "seconds", min: "minutes", h: "hours",
  kb: "kilobytes", mb: "megabytes", gb: "gigabytes", tb: "terabytes",
  kib: "kibibytes", mib: "mebibytes", gib: "gibibytes",
  khz: "kilohertz", hz: "hertz", px: "pixels",
};
const UNIT_RE = new RegExp(String.raw`\b(\d+(?:\.\d+)?)\s?(${Object.keys(UNITS).join("|")})\b`, "gi");
const ABBREVIATIONS: readonly (readonly [RegExp, string])[] = [
  [/\be\.g\./gi, "for example"], [/\bi\.e\./gi, "that is"], [/\betc\./gi, "et cetera"],
  [/\bvs\.?(?=\s)/gi, "versus"], [/\bapprox\./gi, "approximately"],
];
const SYMBOLS: readonly (readonly [RegExp, string])[] = [
  [/\s*(?:→|->|=>)\s*/g, " to "], [/\s*(?:←|<-)\s*/g, " from "], [/\s&\s/g, " and "],
  [/(?<=\s)~(?=\d)/g, "about "], [/(?<=\d)\s?×\s?(?=\d)/g, " by "], [/≈/g, "about "],
  [/≥/g, "at least "], [/≤/g, "at most "], [/\s+\/\s+/g, " or "],
];
// Emoji and pictographs (with variation selectors and joiners) are dropped silently.
const EMOJI = /(?:[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF]|\uFE0F|\u200D|\u20E3)+/gu;

/** speak_detached -> speak detached; parseConfig -> parse Config. */
function splitIdentifier(word: string): string {
  const spaced = word.includes("_") ? word.replace(/_/g, " ").replace(/-/g, " ") : word;
  return spaced.replace(/(?<=[a-z0-9])(?=[A-Z][a-z])/g, " ").trim();
}

function speakPath(whole: string, prefix: string, dirs: string, last: string): string {
  // Say only the last part of a path; leave "read/write" or "50/50" alone.
  const slashes = dirs.split("/").length - 1;
  return prefix || slashes >= 2 || FILE_WHOLE.test(last) ? last : whole;
}

function speakFile(_: string, name: string, ext: string, line: string | undefined): string {
  const out = `${splitIdentifier(name)} dot ${ext.toLowerCase()}`;
  return line ? `${out}, line ${line}` : out;
}

function speakVersion(whole: string, num: string): string {
  const parts = num.split(".");
  const v = whole.startsWith("v");
  if (!v && parts.length === 2) return whole; // 3.5 is an ordinary decimal
  const spoken = parts.join(" point ");
  return v ? `version ${spoken}` : spoken;
}

function speakUnit(whole: string, num: string, unit: string): string {
  const u = unit.toLowerCase();
  if (u === "s" && /^(?:1[5-9]\d0|20\d0)$/.test(num)) return whole; // "the 1990s"
  const word = UNITS[u] ?? unit;
  return `${num} ${num === "1" ? word.replace(/s$/, "") : word}`;
}

export function cleanForSpeech(input: string): string {
  let text = input.replace(/```.*?```/gs, " ");                    // drop code blocks
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");              // [label](url) -> label
  text = text.replace(/https?:\/\/\S+/g, "a link");
  text = text.replace(EMOJI, "");
  text = text.replace(/`([^`\n]+)`/g, " $1 ");                      // inline code: read as words
  text = text.replace(PATH, speakPath);                              // src/a/hooks.py -> hooks.py
  text = text.replace(SLASH_CMD, (_m, cmd: string, sub?: string) => (sub ? `${cmd} ${sub}` : cmd));
  text = text.replace(FILE, speakFile);
  text = text.replace(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g, splitIdentifier);
  text = text.replace(/\b[a-z]{2,}(?:[A-Z][a-z0-9]+)+\b/g, splitIdentifier);
  for (const [re, rep] of ABBREVIATIONS) text = text.replace(re, rep);
  for (const [re, rep] of SYMBOLS) text = text.replace(re, rep);
  text = text.replace(VERSION, speakVersion);
  text = text.replace(UNIT_RE, speakUnit);
  text = text.replace(/[`*_#>|~]/g, "");
  text = text.replace(/^\s*(?:[-•]|\d+[.)])\s+/gm, "");
  text = text.replace(/\s+([,.;:!?])/g, "$1");
  return text.replace(/\s+/g, " ").trim();
}
