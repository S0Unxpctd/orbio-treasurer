/**
 * pnpm probe <P-n>  → runs scripts/probes/p<n>-*.ts and prints REDACTED evidence to paste into docs/api-notes.md.
 * Probes are read-only checks (PRD §13a). They never move money and never print secrets.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = process.argv[2] ?? '';
const m = /^P-?0*(\d+)$/i.exec(arg);
if (!m) {
  console.error('usage: pnpm probe P-<n>   (e.g. pnpm probe P-1)');
  process.exit(2);
}
const n = m[1];
const dir = join(import.meta.dirname, 'probes');
const file = readdirSync(dir).find((f) => f.startsWith(`p${n}-`) && f.endsWith('.ts'));
if (!file) {
  console.error(`no probe script for P-${n} in scripts/probes/ (expected p${n}-<name>.ts)`);
  process.exit(2);
}
await import(join(dir, file));
