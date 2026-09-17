/**
 * Serves this example's own recordings, with the viewer mounted in.
 *
 *   REWIND_ENABLED=1 pnpm -F deep-research-agent start   # write some runs
 *   pnpm -F deep-research-agent view                     # then look at them
 *
 * Six lines of wiring and no database: `fileIngestStore` reads the same `.rewind`
 * directory the recorder just wrote, over the same `/v1` routes a Postgres-backed
 * server answers. The viewer cannot tell the difference, which is the point of there
 * being one API.
 */
import { fileIngestStore } from '@krishnadobhal/rewind-server/files';
import { createIngestServer } from '@krishnadobhal/rewind-server/ingest';
import { loadEnvFile } from '@krishnadobhal/rewind-sdk-js/env';
import { staticPath } from '@krishnadobhal/rewind-ui';

loadEnvFile(); // the same .env the recorder read, so REWIND_DIR agrees

const dir = process.env['REWIND_DIR'] ?? '.rewind';
const port = Number(process.env['PORT'] ?? 4100);

// The assets ship built; mounting them is what spares the page a proxy and CORS.
const server = createIngestServer({ store: fileIngestStore(dir), ui: staticPath });

server.listen(port, () => {
  console.log(`viewer  http://localhost:${port}  reading ${dir}`);
});
