/**
 * canonicalize ships `module.exports = serialize` but declares `export default serialize`,
 * so a default import type-checks as the namespace and is not callable. This declares
 * what the package actually exports.
 *
 * Drop this file if upstream fixes lib/canonicalize.d.ts.
 */
declare module 'canonicalize' {
  /** RFC 8785 JSON Canonicalization Scheme. Returns undefined for non-JSON values. */
  function canonicalize(value: unknown): string | undefined;
  export = canonicalize;
}
