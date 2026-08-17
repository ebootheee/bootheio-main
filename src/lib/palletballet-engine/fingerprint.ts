/**
 * Stable content hash of the physically-relevant config fields.
 *
 * Used as the model/result cache key and surfaced as `SafetyResult.config_hash`.
 *
 * NOTE: this is deliberately NOT the same value as the Python engine's hash.
 * That one is `sha256(PalletConfig.model_dump_json(exclude={"notes"}))[:16]`,
 * which would mean reproducing pydantic's exact JSON encoding — field order,
 * computed fields, and float repr — byte for byte, plus a synchronous SHA-256
 * (WebCrypto's digest is async). All of that to reproduce a display string that
 * no comparison depends on. Same shape (16 hex chars), same guarantee
 * (physically identical configs hash identically within one engine), different
 * value across engines.
 */

import type { PalletConfig } from './types.js';

/** Canonical string form: every field that changes the physics, in fixed order. */
function canonical(config: PalletConfig): string {
  const parts: string[] = [
    config.pallet_id,
    config.base_pallet_type,
    config.base_dims_m.join(','),
    String(config.base_mass_kg),
    config.wrap,
    config.env,
    String(config.body_temp_c),
    String(config.seconds_since_temp_change),
  ];
  for (const item of config.items) {
    parts.push(
      item.sku,
      String(item.weight_kg),
      item.dims_m.join(','),
      item.fragility,
      item.position.join(','),
      String(item.orientation_deg),
    );
  }
  return parts.join('|');
}

/** 64-bit FNV-1a over the canonical form, rendered as 16 lowercase hex chars. */
export function configFingerprint(config: PalletConfig): string {
  const s = canonical(config);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash ^ BigInt(s.charCodeAt(i) & 0xff)) * prime) & mask;
    // Mix the high byte of multi-byte code units so non-ASCII ids don't collide.
    const hi = s.charCodeAt(i) >> 8;
    if (hi) hash = ((hash ^ BigInt(hi)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}
