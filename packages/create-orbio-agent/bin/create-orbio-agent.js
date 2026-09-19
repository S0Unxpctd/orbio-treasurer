#!/usr/bin/env node
/**
 * create-orbio-agent — scaffolds a cron agent that calls the Orbio Treasurer gateway with
 * `model: "auto"` and (optionally) registers it so it shows up on the public page.
 *
 * No dependencies beyond Node 22 built-ins (docs/PRD-1.0-sprint.md §4 T-9; tasks/S-09.md "In
 * scope"). This ticket also supersedes CLAUDE.md #5c for this package specifically: the kit is
 * a *caller*, it has no ledger of its own (the Treasurer meters it server-side), so it needs
 * neither a database nor SQLite — and, in the same spirit, ships as plain JS with no build step,
 * so `bin/create-orbio-agent.js` runs directly, no `pnpm build` required first.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEMPLATE_DIR = path.join(PACKAGE_ROOT, 'template');

// No slashes, no leading dot — keeps the target a plain subdirectory of cwd and out of
// `__AGENT_NAME__` substitution's way (a name containing `__` would be indistinguishable from
// the placeholder token itself, so it's rejected too).
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function usage() {
  return [
    'Usage: create-orbio-agent <name> [--gateway <url>] [--key <otk_...>]',
    '',
    '  <name>      folder to create (must not already exist)',
    '  --gateway   the Orbio Treasurer gateway base URL (default: see defaults.json)',
    '  --key       an otk_... API key. Omit it and fill ORBIO_TREASURER_KEY into .env yourself.',
  ].join('\n');
}

function loadDefaultGatewayUrl() {
  const raw = readFileSync(path.join(PACKAGE_ROOT, 'defaults.json'), 'utf8');
  return JSON.parse(raw).gatewayUrl;
}

/** True for the shipped `defaults.json` placeholder (`https://<REFERENCE_HOST>`) and for any
 *  other `<...>`-bracketed stand-in a future default might use — never true for a real URL. */
function isPlaceholderGatewayUrl(url) {
  return /<[^>]+>/.test(url);
}

/** S-09 tester finding (tasks/S-09.md Test report): when `--gateway` is omitted, nothing in the
 *  scaffolded output told the user the default is a stand-in they must replace. Substituted into
 *  `template/README.md` only — empty string when a real `--gateway` was given, so a scaffold
 *  produced with an explicit gateway never contains this text or the placeholder token itself. */
function buildGatewayWarningBlock(gatewayUrl) {
  if (!isPlaceholderGatewayUrl(gatewayUrl)) return '';
  return (
    '\n> **Placeholder gateway.** `--gateway` was not passed, so `ORBIO_TREASURER_URL` above is ' +
    `still the placeholder \`${gatewayUrl}\` — it will never resolve. Replace it with a real ` +
    'Treasurer URL in `.env`/`.env.example`, or re-run `create-orbio-agent --gateway <url>`.\n'
  );
}

/**
 * Recursively copies `srcDir` into `destDir`, substituting `__AGENT_NAME__`/`__GATEWAY_URL__`/
 * `__GATEWAYWARNING__` in every file's text content. Deliberately does not know about a
 * key/secret at all — the template ships no `__AGENT_KEY__`-shaped token, so there is no code
 * path here that could ever write a real key into a copied (and possibly committed) template
 * file (AC7).
 */
function scaffold(srcDir, destDir, vars) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      scaffold(srcPath, destPath, vars);
      continue;
    }
    const raw = readFileSync(srcPath, 'utf8');
    const text = raw
      .replaceAll('__AGENT_NAME__', vars.name)
      .replaceAll('__GATEWAY_URL__', vars.gatewayUrl)
      .replaceAll('__GATEWAYWARNING__', vars.gatewayWarning);
    writeFileSync(destPath, text, 'utf8');
  }
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        gateway: { type: 'string' },
        key: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error('');
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  if (parsed.values.help) {
    console.log(usage());
    return;
  }

  const name = parsed.positionals[0];
  if (!name) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  if (!NAME_RE.test(name) || name.includes('__')) {
    console.error(
      'create-orbio-agent: <name> must start with a letter or digit and contain only letters, digits, ".", "_", "-" (and no "__")',
    );
    process.exitCode = 1;
    return;
  }

  const targetDir = path.resolve(process.cwd(), name);
  if (existsSync(targetDir)) {
    console.error(`create-orbio-agent: "${name}" already exists in this directory`);
    process.exitCode = 1;
    return;
  }

  const gatewayUrl = parsed.values.gateway ?? loadDefaultGatewayUrl();
  const key = parsed.values.key ?? '';
  const usingPlaceholderGateway = isPlaceholderGatewayUrl(gatewayUrl);

  scaffold(TEMPLATE_DIR, targetDir, {
    name,
    gatewayUrl,
    gatewayWarning: buildGatewayWarningBlock(gatewayUrl),
  });

  // `.env.example` (just copied above) never carries a real key — see scaffold()'s comment. A
  // real `.env` is written here, separately, and only when a key was actually given: it's the
  // one file in the whole scaffold that can hold a secret, and the copied `.gitignore` keeps it
  // out of the user's own git history.
  if (key) {
    writeFileSync(
      path.join(targetDir, '.env'),
      `ORBIO_TREASURER_URL=${gatewayUrl}\nORBIO_TREASURER_KEY=${key}\n`,
      'utf8',
    );
  }

  console.log(`Created ${name}/`);
  console.log('');
  if (usingPlaceholderGateway) {
    console.log(
      `WARNING: no --gateway was passed, so ORBIO_TREASURER_URL is still the placeholder ` +
        `"${gatewayUrl}" — it will never resolve. Pass --gateway <url> next time, or edit ` +
        `.env/.env.example yourself. See ${name}/README.md.`,
    );
    console.log('');
  }
  console.log('Next steps:');
  console.log(`  cd ${name}`);
  if (!key) {
    console.log('  cp .env.example .env   # then fill in ORBIO_TREASURER_KEY, see README.md');
  }
  console.log('  npm start              # runs the digest once, prints it');
  console.log('  npm run register       # shows up on the public page within a minute');
}

main(process.argv.slice(2));
