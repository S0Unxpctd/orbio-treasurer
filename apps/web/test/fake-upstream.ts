/**
 * In-process fake Orbio gateway for the S-01 integration tests (CLAUDE.md: "Never call the real
 * Orbio gateway in tests"). A real `node:http` server on `127.0.0.1`, replaying the synthetic,
 * dated fixtures in `packages/core/src/router/fixtures/` — see that directory's README.md.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = fileURLToPath(
  new URL('../../../packages/core/src/router/fixtures/', import.meta.url),
);

export const CATALOG_FIXTURE: unknown = JSON.parse(
  readFileSync(`${FIXTURES_DIR}models-catalog.2026-09-19.json`, 'utf8'),
);
export const NONSTREAM_FIXTURE: unknown = JSON.parse(
  readFileSync(`${FIXTURES_DIR}chat-completion.nonstream.2026-09-19.json`, 'utf8'),
);
export const STREAM_FIXTURE_SSE: string = readFileSync(
  `${FIXTURES_DIR}chat-completion.stream.2026-09-19.sse`,
  'utf8',
);

export type UpstreamMode = 'ok' | 'treasury_empty' | 'server_error';

export interface RecordedRequest {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

export interface FakeUpstream {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

/** Starts a fresh fake upstream on an ephemeral port. `mode` controls `/chat/completions`'s
 *  behaviour; `/models` always replays the catalog fixture. */
export function startFakeUpstream(mode: UpstreamMode = 'ok'): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      requests.push({
        path: req.url ?? '',
        authorization: req.headers.authorization,
        body,
      });

      if (req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(CATALOG_FIXTURE));
        return;
      }

      if (req.url === '/chat/completions') {
        if (mode === 'treasury_empty') {
          res.writeHead(402, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ error: { type: 'insufficient_balance', message: 'no credit' } }),
          );
          return;
        }
        if (mode === 'server_error') {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ error: { type: 'internal', message: 'synthetic upstream failure' } }),
          );
          return;
        }

        const isStream =
          !!body && typeof body === 'object' && (body as { stream?: unknown }).stream === true;
        if (isStream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          // Two writes, not one — exercises the passthrough actually reading chunk-by-chunk
          // rather than assuming the whole SSE body arrives in a single read (audit focus: "SSE
          // passthrough not buffering the whole stream").
          const mid = Math.floor(STREAM_FIXTURE_SSE.length / 2);
          res.write(STREAM_FIXTURE_SSE.slice(0, mid));
          setTimeout(() => {
            res.write(STREAM_FIXTURE_SSE.slice(mid));
            res.end();
          }, 5);
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(NONSTREAM_FIXTURE));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('fake upstream failed to bind a port'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

/** Polls `predicate` until it's true or `timeoutMs` elapses — used to wait for the fire-and-forget
 *  recorder call after a streaming response's usage chunk resolves asynchronously. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
