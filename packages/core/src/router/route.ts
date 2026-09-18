/**
 * `route()` — the router's one pure function (S-01 AC1: no imports of fs/net/Date; every input is
 * a parameter, nothing is read from the environment or the clock).
 *
 * `route(input, catalog, opts) → { model, tier, reason }` (docs/PRD-1.0-sprint.md §4 T-1):
 *
 *  1. Explicit exact Orbio model id (`requestedModel` is neither `"auto"` nor `"auto:S|M|L"`) →
 *     pass through untouched: `tier` is derived from its catalog price, `reason: "explicit"`. An
 *     id not in the catalog throws `RouterError('unknown_model', …)`.
 *  2. Otherwise (`"auto"` or `"auto:X"`), in order:
 *     a. Classify the minimum tier the request needs from its shape (`classifyTier`):
 *        `tools` present, or `response_format` asking for JSON → ≥ M; else prompt > 24 000 chars
 *        → ≥ M; else a system message matches `/\b(reason|analy|code|plan)/i` → ≥ M; else S.
 *     b. Raise to the `auto:X` floor, if any (`auto` alone has no floor).
 *     c. Cap by policy mode (`eco` → cap at M, `critical` → cap at S, `normal` → no cap). The cap
 *        is applied *after* the floor, so a cap always wins over a floor — `reason` says so.
 *  3. Pick a model for the resulting tier: the cheapest allowed (`ROUTER_ALLOW`) model in that
 *     tier, or the nearest non-empty tier if it has none (`selectModelForTier`). No allowed model
 *     anywhere throws `RouterError('no_model_in_tier', …)`.
 */
import { maxTier, minTier, priceTier, selectModelForTier, tierRank } from './pricing.js';
import type {
  ModelCatalogEntry,
  RouteInput,
  RouteMessage,
  RouteOpts,
  RouteResult,
  Tier,
} from './types.js';
import { RouterError } from './types.js';

export { cheapestInTier, priceTier } from './pricing.js';

const SYSTEM_KEYWORD_RE = /\b(reason|analy|code|plan)/i;
const PROMPT_CHAR_LIMIT = 24_000;
const AUTO_FLOOR_RE = /^auto:(S|M|L)$/;

/** Best-effort plain-text extraction from an OpenAI `content` field: a string, or the joined
 *  `text` parts of a multimodal content array. Anything else (e.g. `null`) counts as no text. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join(' ');
  }
  return '';
}

function promptCharCount(messages: readonly RouteMessage[]): number {
  let total = 0;
  for (const m of messages) total += messageText(m.content).length;
  return total;
}

function wantsJsonResponseFormat(responseFormat: RouteInput['responseFormat']): boolean {
  if (!responseFormat) return false;
  const type = responseFormat.type;
  return type !== undefined && type !== 'text';
}

/** Minimum tier the request's *shape* needs, independent of floor/cap. Exported for direct,
 *  rule-by-rule table tests. */
export function classifyTier(input: RouteInput): { tier: Tier; ruleId: string } {
  const hasTools = Array.isArray(input.tools) && input.tools.length > 0;
  if (hasTools) return { tier: 'M', ruleId: 'rule:tools' };
  if (wantsJsonResponseFormat(input.responseFormat)) {
    return { tier: 'M', ruleId: 'rule:response_format_json' };
  }
  if (promptCharCount(input.messages) > PROMPT_CHAR_LIMIT) {
    return { tier: 'M', ruleId: 'rule:prompt_length' };
  }
  const systemText = input.messages
    .filter((m) => m.role === 'system')
    .map((m) => messageText(m.content))
    .join(' ');
  if (SYSTEM_KEYWORD_RE.test(systemText)) {
    return { tier: 'M', ruleId: 'rule:system_keyword' };
  }
  return { tier: 'S', ruleId: 'rule:default' };
}

/** `auto:S|M|L` → that tier; bare `"auto"` (or anything else) → no floor. */
function floorFromRequestedModel(requestedModel: string): Tier | null {
  const match = AUTO_FLOOR_RE.exec(requestedModel);
  return match ? (match[1] as Tier) : null;
}

function capFromMode(mode: RouteOpts['mode']): Tier {
  if (mode === 'eco') return 'M';
  if (mode === 'critical') return 'S';
  return 'L'; // normal (default): no effective cap
}

function isExplicitModelRequest(requestedModel: string): boolean {
  return requestedModel !== 'auto' && !AUTO_FLOOR_RE.test(requestedModel);
}

export function route(
  input: RouteInput,
  catalog: readonly ModelCatalogEntry[],
  opts: RouteOpts = {},
): RouteResult {
  if (isExplicitModelRequest(input.requestedModel)) {
    const entry = catalog.find((e) => e.id === input.requestedModel);
    if (!entry) {
      throw new RouterError('unknown_model', `unknown explicit model: "${input.requestedModel}"`);
    }
    return { model: entry.id, tier: priceTier(entry), reason: 'explicit' };
  }

  const mode = opts.mode ?? 'normal';
  const { tier: ruleTier, ruleId } = classifyTier(input);

  const floor = floorFromRequestedModel(input.requestedModel);
  const withFloor = floor ? maxTier(ruleTier, floor) : ruleTier;
  const floorRaised = floor !== null && tierRank(withFloor) > tierRank(ruleTier);

  const cap = capFromMode(mode);
  const capped = minTier(withFloor, cap);
  const capLowered = tierRank(capped) < tierRank(withFloor);

  const reasonParts = [ruleId];
  if (floorRaised) reasonParts.push(`floor:auto:${floor}`);
  if (capLowered) {
    reasonParts.push(`cap:${mode}`);
    if (floorRaised) reasonParts.push('cap-overrides-floor');
  }

  const selection = selectModelForTier(catalog, capped, opts.allowList);
  if (!selection) {
    throw new RouterError('no_model_in_tier', `no allowed model available (target tier ${capped})`);
  }
  if (selection.tier !== capped) reasonParts.push(`fallback:${selection.tier}`);

  return { model: selection.entry.id, tier: selection.tier, reason: reasonParts.join(';') };
}
