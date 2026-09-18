/**
 * `GET /v1/models` (S-01 AC5) — proxies the Orbio catalog and adds `auto`, `auto:S`, `auto:M`,
 * `auto:L`. No auth required (ticket doesn't list it under "Caller auth"; the catalog itself
 * carries no secret).
 */
import { buildAutoModelEntries, redact } from '@orbio-treasurer/core';

import { getCatalog, getEnv } from '../_gateway.js';

export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  let env: ReturnType<typeof getEnv>;
  try {
    env = getEnv();
  } catch (err) {
    console.error(JSON.stringify(redact({ msg: 'v1/models: env config error', err })));
    return Response.json(
      { error: { type: 'config', message: 'server misconfigured' } },
      { status: 500 },
    );
  }

  try {
    const catalog = await getCatalog(env);
    return Response.json(
      { ...catalog.raw, data: [...catalog.raw.data, ...buildAutoModelEntries()] },
      { status: 200 },
    );
  } catch (err) {
    console.error(JSON.stringify(redact({ msg: 'v1/models: catalog fetch failed', err })));
    return Response.json(
      { error: { type: 'upstream_error', message: 'could not load model catalog' } },
      { status: 502 },
    );
  }
}
