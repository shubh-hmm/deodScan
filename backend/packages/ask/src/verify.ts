// The safety net behind "every number comes from your data": before an answer is shown, every figure in it is looked up in what the data tools
// returned (and in the question). A figure the model invented or computed itself will not be found, and the answer is not shown as it is.
// Matching allows only honest rounding: "1.27M" matches 1,270,524.83 because 1.27M is shown to the nearest 0.01M, but "1.3M" does not match 1.2M.
import { Decimal } from 'decimal.js';

export interface Figure { value: Decimal; tol: Decimal; raw: string }

const MULT: Record<string, Decimal> = { K: new Decimal(1e3), M: new Decimal(1e6), B: new Decimal(1e9), T: new Decimal(1e12) };

/** Removes things that look like numbers but are identifiers: addresses and hashes, dates and times, versions. */
function stripNonFigures(text: string): string {
  return text
    .replace(/0x[0-9a-fA-F]+/g, ' ')
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/\bV[23]\b/g, ' ')
    .replace(/^\s*\d+[.)]\s/gm, ' ');                       // "1. " list numbering
}

const FIGURE = /(\$)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?([KMBT])\b)?/g;

/** Every figure in a piece of text, with the rounding it was shown with. */
export function extractFigures(text: string, opts: { skipSmall?: boolean } = {}): Figure[] {
  const out: Figure[] = [];
  for (const m of stripNonFigures(text).matchAll(FIGURE)) {
    const [raw, dollar, intPart, frac, suffix] = m;
    const base = new Decimal(`${intPart!.replace(/,/g, '')}${frac ?? ''}`);
    const mult = suffix ? MULT[suffix]! : new Decimal(1);
    const value = base.times(mult);
    const decimals = frac ? frac.length - 1 : 0;
    const tol = new Decimal(0.5).times(new Decimal(10).pow(-decimals)).times(mult);
    // Plain small whole numbers (3, 7, 30: counts, days, "top 5") and years are ordinary words, not data claims.
    const plainWhole = !dollar && !frac && !suffix && !intPart!.includes(',');
    if (opts.skipSmall && plainWhole && (value.lte(100) || (value.gte(1990) && value.lte(2100)))) continue;
    out.push({ value, tol, raw: raw!.trim() });
  }
  return out;
}

/** Every number the tools returned, walking the whole result: real numbers, numeric strings, and numbers written inside text. */
export function collectFigures(data: unknown, into: Figure[] = []): Figure[] {
  if (typeof data === 'number' && Number.isFinite(data)) into.push({ value: new Decimal(data), tol: new Decimal(0), raw: String(data) });
  else if (typeof data === 'string') {
    if (/^-?\d+(\.\d+)?$/.test(data)) into.push({ value: new Decimal(data).abs(), tol: new Decimal(0), raw: data });
    else for (const f of extractFigures(data)) into.push(f);
  } else if (Array.isArray(data)) for (const x of data) collectFigures(x, into);
  else if (data && typeof data === 'object') for (const x of Object.values(data)) collectFigures(x, into);
  return into;
}

export interface Verification { ok: boolean; unverified: string[]; checked: number }

/** Checks every figure of the answer against the allowed figures (tool results plus the question). */
export function verifyAnswer(answer: string, allowed: Figure[]): Verification {
  const figures = extractFigures(answer, { skipSmall: true });
  const unverified = figures.filter((f) => !allowed.some((a) => f.value.minus(a.value).abs().lte(f.tol.plus(a.tol)))).map((f) => f.raw);
  return { ok: unverified.length === 0, unverified: [...new Set(unverified)], checked: figures.length };
}
