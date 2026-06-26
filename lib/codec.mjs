// JSON-safe encode/decode for oracle args. Many argument values don't survive a JSON round-trip and would
// silently corrupt (or THROW on) the persisted oracle:
//   RegExp / Set / Map        flatten to '{}'
//   Uint8Array/Buffer         -> '{"0":..}' (type lost)
//   bigint                    THROWS
//   undefined                 array-elem -> null ; object/Map value dropped
//   NaN / ±Infinity           -> null
//   boxed Number/String/Boolean  -> plain object (class identity lost)
// Encode at store-time (tagged forms), decode at use-time, display faithfully in re-emitter prompts. These
// tags are mirrored by the rdv OSS verifier (cli/rdv.mts reviveArg/dispArg) so a stamped oracle re-derives
// there too — keep the two in lockstep when adding a tag.
export function encode(v) {
  if (v === undefined) return { __t: 'undef' };
  if (typeof v === 'bigint') return { __t: 'bigint', v: v.toString() };
  if (Object.is(v, -0)) return { __t: 'num', v: '-0' };                                 // -0 (finite, but JSON collapses to 0); lodash baseToString special-cases -0 -> "-0"
  if (typeof v === 'number' && !Number.isFinite(v)) return { __t: 'num', v: String(v) }; // NaN, ±Infinity
  if (v instanceof RegExp) return { __t: 'regex', source: v.source, flags: v.flags };
  if (v instanceof Number || v instanceof String || v instanceof Boolean) return { __t: 'boxed', k: v.constructor.name, v: encode(v.valueOf()) };
  if (v instanceof Set) return { __t: 'set', values: [...v].map(encode) };
  if (v instanceof Map) return { __t: 'map', entries: [...v].map(([k, val]) => [encode(k), encode(val)]) };
  if (v instanceof Uint8Array) { try { return { __t: 'u8', bytes: Array.from(v), buf: typeof Buffer !== 'undefined' && Buffer.isBuffer(v) }; } catch { /* pseudo/detached typed-array: instanceof true but no backing buffer (e.g. clone@2 of a Uint8Array) — fall through to the generic-object branch (own index keys) */ } }
  if (Array.isArray(v)) {
    // Sparse arrays: holes don't survive JSON (JSON.stringify([,,9]) -> "[null,null,9]"), but slice-family fns
    // (initial/tail/slice) DENSIFY holes to `undefined` — distinct from an explicit null element. Preserve holes
    // via a {__t:'sparse'} form. Dense arrays (the common case) are unchanged.
    let sparse = false;
    for (let i = 0; i < v.length; i++) { if (!(i in v)) { sparse = true; break; } }
    if (!sparse) return v.map(encode);
    const entries = []; for (let i = 0; i < v.length; i++) { if (i in v) entries.push([i, encode(v[i])]); }
    return { __t: 'sparse', length: v.length, entries };
  }
  if (v && typeof v === 'object') {
    // Skip function-valued own keys: (a) JSON.stringify drops function values anyway, and (b) a borrowed
    // `toJSON` (e.g. lodash.merge copying Buffer.prototype methods as own props onto a plain object) would
    // otherwise hijack JSON.stringify and throw "TypedArray.prototype.length on incompatible receiver".
    const o = {}; for (const k of Object.keys(v)) { if (typeof v[k] === 'function') continue; o[k] = encode(v[k]); } return o;
  }
  return v;
}

export function decode(v) {
  // idempotent: live values (raw genInputs) pass through unchanged
  if (v === undefined || typeof v === 'bigint' || (typeof v === 'number' && !Number.isFinite(v))) return v;
  if (v instanceof RegExp || v instanceof Set || v instanceof Map || v instanceof Uint8Array || v instanceof Number || v instanceof String || v instanceof Boolean) return v;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (v.__t === 'undef') return undefined;
    if (v.__t === 'bigint') return BigInt(v.v);
    if (v.__t === 'num') return Number(v.v);
    if (v.__t === 'regex') return new RegExp(v.source, v.flags);
    if (v.__t === 'boxed') { const x = decode(v.v); return v.k === 'Number' ? new Number(x) : v.k === 'String' ? new String(x) : new Boolean(x); }
    if (v.__t === 'set') return new Set(v.values.map(decode));
    if (v.__t === 'map') return new Map(v.entries.map(([k, val]) => [decode(k), decode(val)]));
    if (v.__t === 'u8') return v.buf && typeof Buffer !== 'undefined' ? Buffer.from(v.bytes) : Uint8Array.from(v.bytes);
    if (v.__t === 'sparse') { const a = new Array(v.length); for (const [i, val] of v.entries) a[i] = decode(val); return a; }
    const o = {}; for (const k of Object.keys(v)) o[k] = decode(v[k]); return o;
  }
  if (Array.isArray(v)) return v.map(decode);
  return v;
}

// human/agent-readable rendering for the frozen-oracle block (live values OR encoded tagged forms)
export function display(v) {
  if (v === undefined) return 'undefined';
  if (typeof v === 'bigint') return v.toString() + 'n';
  if (Object.is(v, -0)) return '-0';
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  if (v instanceof RegExp) return v.toString();
  if (v instanceof Number || v instanceof String || v instanceof Boolean) return `new ${v.constructor.name}(${display(v.valueOf())})`;
  if (v instanceof Set) return 'new Set([' + [...v].map(display).join(', ') + '])';
  if (v instanceof Map) return 'new Map([' + [...v].map(([k, val]) => '[' + display(k) + ', ' + display(val) + ']').join(', ') + '])';
  if (v instanceof Uint8Array) { try { return (typeof Buffer !== 'undefined' && Buffer.isBuffer(v) ? 'Buffer' : 'Uint8Array') + '.from([' + Array.from(v).join(', ') + '])'; } catch { /* pseudo/detached typed-array — fall through to generic-object rendering */ } }
  if (Array.isArray(v)) return '[' + v.map(display).join(', ') + ']';
  if (v && typeof v === 'object') {
    if (v.__t === 'undef') return 'undefined';
    if (v.__t === 'bigint') return v.v + 'n';
    if (v.__t === 'num') return v.v;
    if (v.__t === 'regex') return '/' + v.source + '/' + v.flags;
    if (v.__t === 'boxed') return `new ${v.k}(${display(v.v)})`;
    if (v.__t === 'set') return 'new Set([' + v.values.map(display).join(', ') + '])';
    if (v.__t === 'map') return 'new Map([' + v.entries.map(([k, val]) => '[' + display(k) + ', ' + display(val) + ']').join(', ') + '])';
    if (v.__t === 'u8') return (v.buf ? 'Buffer' : 'Uint8Array') + '.from([' + v.bytes.join(', ') + '])';
    if (v.__t === 'sparse') { const parts = []; let prev = 0; for (const [i, val] of v.entries) { if (i > prev) parts.push('<' + (i - prev) + ' empty>'); parts.push(display(val)); prev = i + 1; } if (v.length > prev) parts.push('<' + (v.length - prev) + ' empty>'); return '[' + parts.join(', ') + ']'; }
    return '{' + Object.keys(v).map((k) => JSON.stringify(k) + ': ' + display(v[k])).join(', ') + '}';
  }
  return JSON.stringify(v);
}
