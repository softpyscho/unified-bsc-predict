import { bnb, countdown, priceDelta, usd } from '../lib/format';
import type { MarketState, Round } from '../types';
import { EpochLink, OutcomeTag, Status } from './ui';

export function PoolBar({ bull, bear }: { bull: string; bear: string }) {
  const b = Number(BigInt(bull) / 10n ** 12n);
  const s = Number(BigInt(bear) / 10n ** 12n);
  const total = b + s;
  if (total === 0) {
    return (
      <div className="pool" aria-label="empty pool">
        <div className="empty" />
      </div>
    );
  }
  return (
    <div
      className="pool"
      aria-label={`UP ${((b / total) * 100).toFixed(0)}%, DOWN ${((s / total) * 100).toFixed(0)}%`}
    >
      {b > 0 && <div className="b" style={{ flexGrow: b }} />}
      {s > 0 && <div className="s" style={{ flexGrow: s }} />}
    </div>
  );
}

function Pool({ r }: { r: Round }) {
  return (
    <>
      <PoolBar bull={r.bullAmount} bear={r.bearAmount} />
      <dl className="kv">
        <dt>▲ UP pool</dt>
        <dd>
          {bnb(r.bullAmount, 3)} BNB · {r.bullPayout ? `${r.bullPayout.toFixed(2)}×` : '—'}
        </dd>
        <dt>▼ DOWN pool</dt>
        <dd>
          {bnb(r.bearAmount, 3)} BNB · {r.bearPayout ? `${r.bearPayout.toFixed(2)}×` : '—'}
        </dd>
        <dt>Total</dt>
        <dd>{bnb(r.totalAmount, 3)} BNB</dd>
      </dl>
    </>
  );
}

export function RoundCards({ market, now }: { market: MarketState; now: number | null }) {
  const { expired, live, next, later, oracle } = market;
  return (
    <div className="rounds">
      {expired && (
        <div className="round">
          <div className="title">
            <strong>
              Expired <EpochLink epoch={expired.epoch} />
            </strong>
            <Status s={expired.status} />
          </div>
          <dl className="kv">
            <dt>Result</dt>
            <dd>
              <OutcomeTag o={expired.outcome ?? (expired.status === 'CLOSING' ? null : undefined)} />
            </dd>
            <dt>Lock</dt>
            <dd>{usd(expired.lockPrice, 3)}</dd>
            <dt>Close</dt>
            <dd>{usd(expired.closePrice, 3)}</dd>
            <dt>Change</dt>
            <dd className={priceDelta(expired.lockPrice, expired.closePrice).cls}>
              {priceDelta(expired.lockPrice, expired.closePrice).text}
            </dd>
          </dl>
          <Pool r={expired} />
        </div>
      )}
      {live && (
        <div className="round">
          <div className="title">
            <strong>
              Live <EpochLink epoch={live.epoch} />
            </strong>
            <Status s={live.status} />
          </div>
          <dl className="kv">
            <dt>Locked at</dt>
            <dd>{usd(live.lockPrice, 3)}</dd>
            <dt>Oracle price</dt>
            <dd>{usd(oracle?.price, 3)}</dd>
            <dt>Change</dt>
            <dd className={priceDelta(live.lockPrice, oracle?.price).cls}>
              {priceDelta(live.lockPrice, oracle?.price).text}
            </dd>
            <dt>Leading</dt>
            <dd>
              {live.lockPrice && oracle
                ? oracle.price > live.lockPrice
                  ? '▲ UP'
                  : oracle.price < live.lockPrice
                    ? '▼ DOWN'
                    : 'tie'
                : '—'}
            </dd>
            <dt>Closes in</dt>
            <dd>{countdown(live.closeTime && now ? live.closeTime - now : null)}</dd>
          </dl>
          <Pool r={live} />
        </div>
      )}
      {next && (
        <div className="round next">
          <div className="title">
            <strong>
              Next <EpochLink epoch={next.epoch} />
            </strong>
            <Status s={next.status} />
          </div>
          <div className="muted small">Accepting bets · locks in</div>
          <div className="countdown num">{countdown(next.lockTime && now ? next.lockTime - now : null)}</div>
          <Pool r={next} />
        </div>
      )}
      {later && (
        <div className="round">
          <div className="title">
            <strong>Later #{later.epoch}</strong>
            <span className="badge">UPCOMING</span>
          </div>
          <dl className="kv">
            <dt>Starts in</dt>
            <dd>{countdown(later.startTime && now ? later.startTime - now : null)}</dd>
            <dt>Interval</dt>
            <dd>{market.params.intervalSeconds}s</dd>
            <dt>Buffer</dt>
            <dd>{market.params.bufferSeconds}s</dd>
            <dt>Treasury fee</dt>
            <dd>{(market.params.treasuryFeeBps / 100).toFixed(2)}%</dd>
            <dt>Min bet</dt>
            <dd>{bnb(market.params.minBetWei)} BNB</dd>
          </dl>
        </div>
      )}
    </div>
  );
}
