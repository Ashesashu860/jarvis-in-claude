/**
 * Text -> Kokoro phonemes, via eSpeak NG (the `phonemizer` package, offline WASM).
 *
 * sherpa-onnx 2.x only reads its built-in lexicon and silently drops any word it doesn't know
 * ("makes", "what's", "GitHub", "Jarvis"...; see spike/FINDINGS.md). Phonemizing ourselves and
 * passing phoneme codepoints avoids that. The normalisation and the eSpeak->Kokoro fixes are ported
 * from kokoro-js 1.2.1 (Apache-2.0, https://github.com/hexgrad/kokoro), British branch.
 */
import { phonemize } from "phonemizer";

const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCT_RUN = new RegExp(`(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}]+\\s*)+`, "g");

/** "1990s" -> "19 90s", "3:05" -> "3 oh 5"; anything else unchanged. */
function splitNum(s: string): string {
  if (s.includes(".")) return s;
  if (s.includes(":")) {
    const [h = 0, m = 0] = s.split(":").map(Number);
    return m === 0 ? `${h} o'clock` : m < 10 ? `${h} oh ${m}` : `${h} ${m}`;
  }
  const year = parseInt(s.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return s;
  const left = s.slice(0, 2), right = parseInt(s.slice(2, 4), 10), plural = s.endsWith("s") ? "s" : "";
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${plural}`;
    if (right < 10) return `${left} oh ${right}${plural}`;
  }
  return `${left} ${right}${plural}`;
}

/** "$5" -> "5 dollars", "£2.50" -> "2 pounds and 50 pence". */
function money(s: string): string {
  const unit = s.startsWith("$") ? "dollar" : "pound";
  const amount = s.slice(1);
  if (isNaN(Number(amount))) return `${amount} ${unit}s`;
  if (!amount.includes(".")) return `${amount} ${unit}${amount === "1" ? "" : "s"}`;
  const [whole = "0", frac = "0"] = amount.split(".");
  const cents = parseInt(frac.padEnd(2, "0"), 10);
  const small = s.startsWith("$") ? (cents === 1 ? "cent" : "cents") : cents === 1 ? "penny" : "pence";
  return `${whole} ${unit}${whole === "1" ? "" : "s"} and ${cents} ${small}`;
}

/** "3.14" -> "3 point 1 4". */
function decimal(s: string): string {
  const [whole = "", frac = ""] = s.split(".");
  return `${whole} point ${frac.split("").join(" ")}`;
}

export function normalize(text: string): string {
  return text
    .replace(/[‘’]/g, "'").replace(/«/g, "“").replace(/»/g, "”").replace(/[“”]/g, '"')
    .replace(/\(/g, "«").replace(/\)/g, "»")
    .replace(/[^\S \n]/g, " ").replace(/ {2,}/g, " ")
    .replace(/\bD[Rr]\.(?= [A-Z])/g, "Doctor")
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, "Mister")
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, "Miss")
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, "Mrs")
    .replace(/\betc\.(?! [A-Z])/gi, "etc")
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, "")
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, money)
    .replace(/\d*\.\d+/g, decimal)
    .replace(/(?<=\d)-(?=\d)/g, " to ")
    .replace(/(?<=\d)S/g, " S")
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, "s")
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, "-"))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, "-")
    .trim();
}

/** eSpeak's symbols -> the ones Kokoro was trained on. */
function toKokoro(ipa: string): string {
  return ipa
    .replace(/kəkˈɔːɹəʊ/g, "kˈəʊkəɹəʊ")
    .replace(/ʲ/g, "j").replace(/r/g, "ɹ").replace(/x/g, "k").replace(/ɬ/g, "l")
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, " ")
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, "z")
    .trim();
}

export class KokoroPhonemizer {
  constructor(private readonly language: "en" | "en-us" = "en") {}

  /** British English by default ("en" is eSpeak's en-gb). */
  async phonemes(text: string): Promise<string> {
    const normalized = normalize(text);
    const parts: string[] = [];
    let last = 0;
    for (const m of normalized.matchAll(PUNCT_RUN)) {
      if (m.index > last) parts.push((await phonemize(normalized.slice(last, m.index), this.language)).join(" "));
      parts.push(m[0]);
      last = m.index + m[0].length;
    }
    if (last < normalized.length) parts.push((await phonemize(normalized.slice(last), this.language)).join(" "));
    return toKokoro(parts.join(""));
  }
}
