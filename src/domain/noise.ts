/**
 * Transcripts that are almost certainly not a prompt: what speech recognisers write over a cough,
 * a breath or silence. Only exact matches count, so "thanks, that fixed it" still gets through.
 */
const NOISE = new Set([
  "", "you", "thank you", "thanks", "bye", "okay", "uh", "um", "hmm", "mm", "so", "oh", "ah", "huh",
  "the end", "thanks for watching", "thank you for watching",
]);

export function isNoise(text: string): boolean {
  const n = text.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  return NOISE.has(n);
}
