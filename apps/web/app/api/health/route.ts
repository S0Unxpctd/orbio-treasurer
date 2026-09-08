export const runtime = 'nodejs';

export function GET() {
  return Response.json({ ok: true, service: 'orbio-treasurer-web', at: new Date().toISOString() });
}
