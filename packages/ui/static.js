/**
 * Where the built viewer lives on disk, for a server to mount.
 *
 * This package ships assets, not a process: the bundle already contains React, so it
 * has no runtime dependencies and starts nothing. Hand `staticPath` to
 * `createIngestServer({ ui })` and the viewer is served from the same origin as the
 * API it reads, which is why it needs no proxy and no CORS.
 */
import { fileURLToPath } from 'node:url';

/** Absolute path to the built viewer's directory. */
export const staticPath = fileURLToPath(new URL('./dist/', import.meta.url));

export default staticPath;
