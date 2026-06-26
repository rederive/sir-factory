// Injected-boundary adapters for TRACE-MODE oracles — the fake HTTP transport.
//
// Mirrors the rderive OSS verifier (cli/rdv.mts makeFakeHttp/runTrace) so a trace-oracle stamped HERE verifies
// identically under `rdv check`. The seam (the real network boundary) is INJECTED, never run: the unit takes
// the transport as a parameter, and the oracle records {emitted (the bytes the unit pushed across the boundary),
// result (what the unit returned)} for a scripted boundary response. A trust-nothing verifier rebuilds the fake
// boundary and re-grades — it never executes a real socket.
//
// Convention (lockstep with rdv): oracle vector args = [a0, a1, script]; the unit is called as fn(a0, a1, http);
// `script` describes the scripted boundary { statusCode, chunks?: string[], error?: string }; expected =
// { emitted, result }. A unit whose transport is not injectable as the 3rd positional arg is NOT trace-able
// under this convention and must be quarantined by the decomposer (don't guess a different ABI).

export function makeFakeHttp(script) {
  const emitted = [];
  const http = {
    request(opts, cb) {
      emitted.push({ op: 'request', opts });
      const res = { statusCode: script.statusCode, setEncoding() {}, on(ev, h) { res['_' + ev] = h; return res; } };
      const req = {
        on(ev, h) { req['_' + ev] = h; return req; },
        write(d) { emitted.push({ op: 'write', data: String(d) }); return true; },
        end() {
          emitted.push({ op: 'end' });
          queueMicrotask(() => {
            if (script.error) { if (req._error) req._error(new Error(script.error)); return; }
            if (cb) cb(res);
            queueMicrotask(() => { for (const c of (script.chunks || [])) if (res._data) res._data(c); if (res._end) res._end(); });
          });
        },
      };
      return req;
    },
  };
  return { http, emitted };
}

export async function runTrace(fn, args) {
  const [a0, a1, script] = args;                                  // last arg = the scripted boundary
  const { http, emitted } = makeFakeHttp(script || {});
  let result;
  try {
    result = await Promise.race([
      Promise.resolve(fn(a0, a1, http)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: never resolved')), 800)),
    ]);
  } catch (e) { result = { __throw: String((e && e.message) || e) }; }
  return { emitted, result };
}
