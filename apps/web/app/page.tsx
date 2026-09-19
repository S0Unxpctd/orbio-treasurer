/**
 * `/` — the public page (S-08, docs/PRD-1.0-sprint.md §4 T-8). Server component, no client JS.
 * Thin by design: every number on the page comes from `renderModel()` (`./model.ts`), a pure
 * function this file doesn't reimplement — see `model.test.ts` for the tested logic.
 *
 * `dynamic = 'force-dynamic'` (ticket) means Next renders this on every request rather than
 * caching the route itself; the 60s freshness window the ticket also asks for is instead applied
 * to the *data fetch* via `unstable_cache` (its other named option), so repeated requests inside
 * that window don't re-hit the ledger even though the page keeps rendering per-request.
 */
import { unstable_cache } from 'next/cache';

import { loadRenderModelInput } from './_data.js';
import { NO_DATA_NOTE, type RenderModel, renderModel, ZERO_SAVINGS } from './model.js';
import { getEnv } from './v1/_gateway.js';

export const dynamic = 'force-dynamic';

const cachedLoad = unstable_cache(
  async (now: string) => loadRenderModelInput(getEnv(), now),
  ['s-08-stats'],
  { revalidate: 60 },
);

async function getModel(): Promise<RenderModel> {
  const now = new Date().toISOString();
  try {
    const input = await cachedLoad(now);
    return renderModel(input);
  } catch {
    // Config/ledger error (e.g. env misconfigured) — AC1/CLAUDE.md: never crash the page. Render
    // the same shape a missing agent produces; the note text is generic on purpose (no secret,
    // no internal detail — CLAUDE.md #4).
    return renderModel({
      now,
      agent: null,
      savings24h: ZERO_SAVINGS,
      savingsAll: ZERO_SAVINGS,
      burnDailyUsd: '0.010000',
      chainSnapshot: null,
      treasuryEvents: [],
      publicAgents: [],
    });
  }
}

export default async function Home() {
  const model = await getModel();

  return (
    <main>
      <h1>Orbio Treasurer</h1>
      <p className="pitch">
        A treasury for AI agents on Orbio. It earns inference credit, meters what it burns, and
        shows the gap in public.
      </p>

      {model.noDataNote && <p className="note">{model.noDataNote}</p>}

      <section className="block">
        <h2>Savings</h2>
        <div className="grid">
          <div className="stat">
            <span className="stat-label">Calls routed (24h)</span>
            <span className="stat-value">{model.savings.h24.calls}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Spent (24h)</span>
            <span className="stat-value">{model.savings.h24.costUsdDisplay}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Baseline (24h)</span>
            <span className="stat-value">{model.savings.h24.baselineUsdDisplay}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Saved (24h)</span>
            <span className="stat-value">{model.savings.h24.savedUsdDisplay}</span>
          </div>
          <div className="stat">
            <span className="stat-label">% saved (24h)</span>
            <span className="stat-value">{model.savings.h24.savedPctDisplay}</span>
          </div>
        </div>
        <div className="grid" style={{ marginTop: 12 }}>
          <div className="stat">
            <span className="stat-label">Calls routed (all-time)</span>
            <span className="stat-value">{model.savings.all.calls}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Spent (all-time)</span>
            <span className="stat-value">{model.savings.all.costUsdDisplay}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Baseline (all-time)</span>
            <span className="stat-value">{model.savings.all.baselineUsdDisplay}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Saved (all-time)</span>
            <span className="stat-value">{model.savings.all.savedUsdDisplay}</span>
          </div>
          <div className="stat">
            <span className="stat-label">% saved (all-time)</span>
            <span className="stat-value">{model.savings.all.savedPctDisplay}</span>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          {model.savings.byTier.map((t) => (
            <div className="tier-row" key={t.tier}>
              <span>Tier {t.tier}</span>
              <span>
                {t.calls} calls · {t.costUsdDisplay}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="block">
        <h2>Treasury</h2>
        {model.treasury ? (
          <div className="grid">
            <div className="stat">
              <span className="stat-label">Staked ORBIO</span>
              <span className="stat-value">{model.treasury.stakedOrbioDisplay}</span>
            </div>
            <div className="stat">
              <span className="stat-label">CREDIT claimable</span>
              <span className="stat-value">{model.treasury.creditClaimableDisplay}</span>
            </div>
            <div className="stat">
              <span className="stat-label">CREDIT in wallet</span>
              <span className="stat-value">{model.treasury.creditWalletDisplay}</span>
            </div>
            <div className="stat">
              <span className="stat-label">API balance available</span>
              <span className="stat-value">{model.treasury.apiAvailableDisplay}</span>
            </div>
            <div className="stat">
              <span className="stat-label">API balance used</span>
              <span className="stat-value">{model.treasury.apiUsedDisplay}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Book quote</span>
              <span className="stat-value">
                {model.treasury.quote
                  ? `${model.treasury.quote.usdgIn} USDG → ${model.treasury.quote.creditOut} CREDIT (${model.treasury.quote.discountPct} discount)`
                  : 'quote unavailable'}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">ETH gas</span>
              <span className="stat-value">{model.treasury.ethGasDisplay}</span>
            </div>
            <div className="stat">
              <span className="stat-label">USDG</span>
              <span className="stat-value">{model.treasury.usdgDisplay}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Mode</span>
              <span className="stat-value">{model.treasury.mode ?? '—'}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Runway</span>
              <span className="stat-value">{model.treasury.runwayDisplay}</span>
            </div>
          </div>
        ) : (
          <p className="note">{NO_DATA_NOTE}</p>
        )}
        {model.treasury && <p className="pitch">Snapshot {model.treasury.ageDisplay}.</p>}
      </section>

      <section className="block">
        <h2>Proof — last {model.events.length} on-chain events</h2>
        {model.noProofNote ? (
          <p className="note">{model.noProofNote}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Amount</th>
                <th>USD</th>
                <th>Time</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {model.events.map((row) => (
                <tr className={row.dryRun ? 'dry-run' : undefined} key={row.id}>
                  <td>{row.kind}</td>
                  <td>{row.amountDisplay ?? '—'}</td>
                  <td>{row.usdValueDisplay ?? '—'}</td>
                  <td>{row.at}</td>
                  <td>
                    {row.explorerUrl ? (
                      <a href={row.explorerUrl} rel="noopener noreferrer">
                        {row.txShort}
                      </a>
                    ) : row.dryRun ? (
                      `dry_run — ${row.reason ?? 'no reason given'}`
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="block">
        <h2>Agents built on this</h2>
        {model.noAgentsNote ? (
          <p className="note">{model.noAgentsNote}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {model.agents.map((a) => (
                <tr key={a.slug}>
                  <td>{a.repoUrl ? <a href={a.repoUrl}>{a.name}</a> : a.name}</td>
                  <td>{a.slug}</td>
                  <td>{a.lastSeenAt ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <footer>{model.footer}</footer>
    </main>
  );
}
