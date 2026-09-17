/**
 * Deny-all network fixture.
 *
 * I6 says a replay that touches the network is a bug, not a warning — and that tests
 * assert it rather than trusting the code. Trusting the code is exactly how a shim
 * that stopped working goes unnoticed: the replay still passes, quietly making live
 * calls, and the determinism rate reads 100% because nothing was watching.
 */
import http from 'node:http';
import https from 'node:https';

/** Every outbound attempt, so a failure can name what was reached for. */
export const attempts: string[] = [];

/** Blocks fetch and the http/https clients until the returned function runs. */
export function denyNetwork(): () => void {
  attempts.length = 0;
  const realFetch = globalThis.fetch;
  const realHttp = http.request;
  const realHttps = https.request;

  const deny = (what: string): never => {
    attempts.push(what);
    throw new Error(`network blocked during replay: ${what}`);
  };

  // fetch rejects rather than throwing, matching the real thing — a caller with a
  // try/catch around an await must see the same shape it would in production.
  globalThis.fetch = ((input: unknown) => {
    attempts.push(`fetch ${String(input)}`);
    return Promise.reject(new Error(`network blocked during replay: fetch ${String(input)}`));
  }) as typeof fetch;
  // Undici sits under fetch, but a provider SDK may reach for these directly.
  http.request = ((...args: unknown[]) => deny(`http ${String(args[0])}`)) as typeof http.request;
  https.request = ((...args: unknown[]) => deny(`https ${String(args[0])}`)) as typeof https.request;

  return () => {
    globalThis.fetch = realFetch;
    http.request = realHttp;
    https.request = realHttps;
  };
}
