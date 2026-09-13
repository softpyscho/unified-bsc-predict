import { useState } from 'react';
import { TradeTable } from '../components/tables';
import { Addr, Card, ErrorBox, ModeBadge, PageHead, Tile, TxLink } from '../components/ui';
import { api } from '../lib/api';
import { bnb, dateTimeMs } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import type { Account, Trade } from '../types';

interface WalletInfo {
  signer: { id: number; address: string; label: string; kind: string } | null;
  hasSigner: boolean;
  balance: string | null;
  balanceError: string | null;
  account: Account | null;
  unclaimed: Trade[];
  claims: {
    id: number;
    epochs: number[];
    txHash: string | null;
    status: string;
    gasCost: string | null;
    error: string | null;
    createdAt: string;
  }[];
  liveTradingEnabled: boolean;
  liveArmed: boolean;
  paperAccount: Account;
}

interface WalletRow {
  id: number;
  address: string;
  label: string;
  kind: 'SIGNER' | 'WATCH';
  userRoundsCursor: number;
  lastSyncedAt: string | null;
  trades: number;
}

export function WalletPage() {
  const info = useApi<WalletInfo>('/api/wallet', ['trade']);
  const wallets = useApi<WalletRow[]>('/api/wallets', ['trade']);
  const action = useAction();
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const w = info.data;

  return (
    <>
      <PageHead
        title="Wallet"
        desc="Signing wallet, claimable winnings and watched wallets. Private keys never leave the server environment."
      />
      <ErrorBox error={info.error ?? action.error} />
      {msg && (
        <div className="alert info" style={{ marginBottom: 12 }}>
          {msg}
        </div>
      )}
      {w && (
        <div className="stack">
          <div className="grid cols-2">
            <Card title="Signing wallet" actions={<ModeBadge mode="LIVE" />}>
              {w.signer ? (
                <div className="tiles">
                  <Tile
                    label="Address"
                    value={<Addr a={w.signer.address} />}
                    hint={w.hasSigner ? 'signer (key in environment)' : 'watch-only'}
                  />
                  <Tile
                    label="Balance"
                    value={w.balance ? bnb(w.balance) : '—'}
                    hint={w.balanceError ?? 'BNB, read now'}
                  />
                  <Tile label="Open exposure" value={bnb(w.account?.exposure)} />
                  <Tile
                    label="Claimable"
                    value={bnb(w.account?.claimable)}
                    hint={`${w.unclaimed.length} rounds`}
                  />
                </div>
              ) : (
                <div className="muted">
                  No wallet configured. Set PRIVATE_KEY (live trading) or WALLET_ADDRESS (watch-only) in the
                  server environment.
                </div>
              )}
            </Card>
            <Card title="Paper account" actions={<ModeBadge mode="PAPER" />}>
              <div className="tiles">
                <Tile
                  label="Bankroll"
                  value={bnb(w.paperAccount.balance)}
                  hint={`started at ${bnb(w.paperAccount.startingBankroll)}`}
                />
                <Tile label="Available" value={bnb(w.paperAccount.available)} />
                <Tile label="Open exposure" value={bnb(w.paperAccount.exposure)} />
              </div>
            </Card>
          </div>
          <Card
            title="Unclaimed winnings & refunds"
            actions={
              <button
                className="primary"
                disabled={!w.hasSigner || !w.liveTradingEnabled || w.unclaimed.length === 0 || action.pending}
                title={!w.liveTradingEnabled ? 'LIVE_TRADING_ENABLED is false' : ''}
                onClick={() =>
                  void action.run(async () => {
                    const r = await api<{ claimedEpochs: number[]; skipped: string | null }>('/api/claims', {
                      method: 'POST',
                    });
                    setMsg(
                      r.claimedEpochs.length
                        ? `Claimed rounds ${r.claimedEpochs.join(', ')}`
                        : `Nothing claimed: ${r.skipped}`,
                    );
                    info.reload();
                  })
                }
              >
                Claim now
              </button>
            }
          >
            <TradeTable rows={w.unclaimed} />
          </Card>
          <Card title="Claim transactions">
            <table>
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Rounds</th>
                  <th>Tx</th>
                  <th>Status</th>
                  <th className="num">Gas</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {w.claims.map((c) => (
                  <tr key={c.id}>
                    <td className="small nowrap">{c.createdAt}</td>
                    <td className="small">{c.epochs.join(', ')}</td>
                    <td>
                      <TxLink hash={c.txHash} />
                    </td>
                    <td>{c.status}</td>
                    <td className="num">{c.gasCost ? bnb(c.gasCost, 6) : '—'}</td>
                    <td className="small neg">{c.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
      <Card
        title="Watched wallets"
        sub="imports every on-chain bet (getUserRounds) into the ledger as IMPORTED live trades"
        className=""
      >
        <div className="row" style={{ marginBottom: 10 }}>
          <input
            placeholder="0x… address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            style={{ width: 380 }}
            className="mono"
          />
          <input placeholder="label" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button
            disabled={!address || action.pending}
            onClick={() =>
              void action.run(async () => {
                await api('/api/wallets', {
                  method: 'POST',
                  body: { address, label: label || 'Watched wallet' },
                });
                setAddress('');
                setLabel('');
                wallets.reload();
              })
            }
          >
            Add wallet
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Address</th>
              <th>Kind</th>
              <th className="num">Bets imported</th>
              <th>Last sync</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {wallets.data?.map((x) => (
              <tr key={x.id}>
                <td>{x.label}</td>
                <td>
                  <Addr a={x.address} />
                </td>
                <td>{x.kind}</td>
                <td className="num">{x.userRoundsCursor.toLocaleString()}</td>
                <td className="small">{x.lastSyncedAt ? dateTimeMs(Date.parse(x.lastSyncedAt)) : 'never'}</td>
                <td>
                  <button
                    className="small"
                    disabled={action.pending}
                    onClick={() =>
                      void action.run(async () => {
                        const r = await api<{ imported: number; total: number }>(
                          `/api/wallets/${x.id}/sync`,
                          { method: 'POST' },
                        );
                        setMsg(`Synced ${x.label}: ${r.imported} new bets imported (${r.total} on-chain).`);
                        wallets.reload();
                      })
                    }
                  >
                    Sync now
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
