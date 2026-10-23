// Exact decimal numbers in MongoDB.
//
// Amounts used to be PostgreSQL NUMERIC. In MongoDB they are Decimal128: 34 significant decimal digits, exact (no floating point), and summed /
// compared / sorted as numbers by the database. Raw on-chain integers (uint256, up to 78 digits) do not fit, so they are kept as digit STRINGS
// next to the Decimal128 value. A value that would need more than 34 digits is refused with a clear error instead of being rounded silently.
import { Decimal128 } from 'mongodb';
import { Decimal } from 'decimal.js';

export const MAX_DIGITS = 34;

/** Number of significant digits of a plain decimal string ("0.017" -> 2, "1270524.83" -> 9, "000.5" -> 1). */
function significantDigits(s: string): number {
  const digits = s.replace(/^[-+]/, '').replace('.', '').replace(/^0+/, '');
  return digits.length;
}

/** Exact string -> Decimal128. Throws when the value is not a plain decimal number or would lose precision. */
export function toDec128(v: string | number | bigint): Decimal128 {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'bigint' ? v.toString() : new Decimal(v).toFixed();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`not a plain decimal number: ${JSON.stringify(s)}`);
  // Trailing zeros after the point are only scale, not precision, so "1.500000000000000000" is fine however long the zero run is.
  const needed = significantDigits(s.includes('.') ? s.replace(/0+$/, '') : s);
  if (needed > MAX_DIGITS) throw new Error(`${s} needs ${needed} significant digits, more than the ${MAX_DIGITS} MongoDB Decimal128 holds exactly`);
  return Decimal128.fromString(s);
}

export const toDec128OrNull = (v: string | number | null | undefined) => (v === null || v === undefined ? null : toDec128(v));

/**
 * Decimal128 (or number, or string) -> plain decimal string, never scientific notation. Non-zero values are padded to `scale` decimals, the way
 * PostgreSQL printed NUMERIC(…, 18) and NUMERIC(…, 30): 12.5 -> "12.500000000000000000". Zero is "0".
 */
export function decStr(v: unknown, scale = 18): string {
  const d = new Decimal(v instanceof Decimal128 ? v.toString() : String(v));
  if (d.isZero()) return '0';
  const [whole, frac = ''] = d.toFixed().split('.');
  return frac.length >= scale ? `${whole}.${frac}` : `${whole}.${frac.padEnd(scale, '0')}`;
}

export const decStrOrNull = (v: unknown, scale = 18): string | null => (v === null || v === undefined ? null : decStr(v, scale));

/** A Decimal.js value from anything the database may return for an amount. */
export const toDecimal = (v: unknown): Decimal => new Decimal(v instanceof Decimal128 ? v.toString() : String(v ?? 0));

/** Decimal128 -> plain decimal string without padding or exponent ("0.43", "12"), for values such as Dune credits. */
export const plainStr = (v: unknown): string | null => (v === null || v === undefined ? null : toDecimal(v).toFixed());

/** A comparison bound from a user-supplied JS number: exact when it fits Decimal128, otherwise the nearest representable value. */
export function toBound(n: number): Decimal128 {
  try { return toDec128(n); } catch { return Decimal128.fromString(n.toExponential()); }
}
