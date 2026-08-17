/**
 * Python float-formatting compatibility.
 *
 * `mjcf.ts` must emit XML byte-identical to `mjcf_builder.py` — not because
 * MuJoCo cares, but because byte-equality is the cheapest possible proof that
 * the whole config→XML path was ported correctly. Two spots where JS and
 * Python disagree by default:
 *
 *   1. `f"{x:.5f}"` rounds half-to-even on the exact binary value; JS
 *      `toFixed` rounds half-away-from-zero. They differ only at exact ties
 *      (e.g. 1/64 = 0.015625 at 5dp → Python "0.01562", JS "0.01563"), which
 *      dyadic item positions can genuinely produce.
 *   2. `str(2.0)` is "2.0" in Python but "2" in JS.
 */

/** `f"{v:.{digits}f}"` — fixed-point with Python's round-half-to-even. */
export function pyFixed(v: number, digits: number): string {
  if (!Number.isFinite(v)) return String(v);

  const pow = 10 ** digits;
  const t = v * 2 * pow;

  // A tie exists only when v * 10^digits lands exactly on .5, i.e. when
  // v * 2 * 10^digits is an odd integer.
  if (Number.isInteger(t) && Math.abs(t % 2) === 1) {
    const half = t / 2; // = v * 10^digits, exactly k + 0.5
    const lower = Math.floor(half);
    const even = lower % 2 === 0 ? lower : lower + 1;
    return formatScaledInt(even, digits, v);
  }

  const s = v.toFixed(digits);
  // Python keeps the sign of negative zero; JS drops it.
  if (Object.is(v, -0) && !s.startsWith('-')) return `-${s}`;
  return s;
}

/** Render `scaled / 10^digits` as a fixed-point string, exactly. */
function formatScaledInt(scaled: number, digits: number, original: number): string {
  const neg = scaled < 0 || (scaled === 0 && Object.is(original, -0));
  const abs = Math.abs(scaled).toString().padStart(digits + 1, '0');
  const cut = abs.length - digits;
  const body = digits === 0 ? abs : `${abs.slice(0, cut)}.${abs.slice(cut)}`;
  return neg ? `-${body}` : body;
}

/** `str(v)` / `f"{v}"` for a Python float: shortest round-trip, always a decimal point. */
export function pyRepr(v: number): string {
  if (Number.isNaN(v)) return 'nan';
  if (v === Infinity) return 'inf';
  if (v === -Infinity) return '-inf';
  const s = String(v);
  if (Number.isInteger(v) && !s.includes('e') && !s.includes('E')) {
    return Object.is(v, -0) ? '-0.0' : `${s}.0`;
  }
  return s;
}

/** `xml.sax.saxutils.escape` — escapes &, <, > and nothing else. */
export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
