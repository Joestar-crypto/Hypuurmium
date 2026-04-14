/**
 * Hypurrmium Auto-Buy Modal
 *
 * 4-step flow:
 *  1. Connect wallet
 *  2. Configure strategy
 *  3. Sign agent authorization (EIP-712)
 *  4. Dashboard — monitor / pause / revoke
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAccount, useConnect, useDisconnect, useSignTypedData, useBalance } from 'wagmi';
import { injected, walletConnect } from 'wagmi/connectors';
import {
  fetchAgentAddress,
  fetchCurrentPE,
  createStrategy,
  fetchStrategy,
  pauseStrategy,
  resumeStrategy,
  deleteStrategy,
  fetchOrders,
  type Strategy,
  type StrategyConfig,
  type Order,
  type PEData,
} from './autobuy-api';

// ── Styles ──

const colors = {
  bg0: '#070e0a',
  bg1: '#0c1812',
  bg2: '#112018',
  bg3: '#172a1f',
  border: '#1f3829',
  text0: '#ede9dc',
  text1: '#8aaa96',
  text2: '#567060',
  accent: '#ffd54f',
  accentDim: 'rgba(255,213,79,0.15)',
  accentGlow: 'rgba(255,213,79,0.45)',
  bull: '#4db87a',
  bear: '#e05252',
  bullDim: 'rgba(77,184,122,0.15)',
  bearDim: 'rgba(224,82,82,0.15)',
};

const s = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.75)',
    backdropFilter: 'blur(6px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  modal: {
    background: colors.bg1,
    border: `1px solid ${colors.border}`,
    borderRadius: 12,
    width: '100%',
    maxWidth: 520,
    maxHeight: '90vh',
    overflow: 'auto',
    boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px',
    borderBottom: `1px solid ${colors.border}`,
  },
  title: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 18,
    fontWeight: 600,
    color: colors.text0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: colors.text2,
    fontSize: 20,
    cursor: 'pointer',
    padding: '4px 8px',
  },
  body: {
    padding: 20,
  },
  steps: {
    display: 'flex',
    gap: 4,
    marginBottom: 20,
  },
  stepDot: (active: boolean, done: boolean) => ({
    flex: 1,
    height: 3,
    borderRadius: 2,
    background: done ? colors.bull : active ? colors.accent : colors.bg3,
    transition: 'background 0.3s',
  }),
  label: {
    fontSize: 11,
    color: colors.text2,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.8px',
    marginBottom: 6,
    fontWeight: 500,
  },
  value: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 14,
    color: colors.text0,
  },
  input: {
    width: '100%',
    background: colors.bg0,
    border: `1px solid ${colors.border}`,
    borderRadius: 6,
    color: colors.text0,
    padding: '10px 12px',
    fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace",
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  select: {
    width: '100%',
    background: colors.bg0,
    border: `1px solid ${colors.border}`,
    borderRadius: 6,
    color: colors.text0,
    padding: '10px 12px',
    fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace",
    outline: 'none',
    appearance: 'none' as const,
    boxSizing: 'border-box' as const,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 12,
    marginBottom: 14,
  },
  field: {
    marginBottom: 14,
  },
  btn: (variant: 'primary' | 'secondary' | 'danger') => ({
    width: '100%',
    padding: '12px 16px',
    border: variant === 'primary'
      ? `1px solid ${colors.accent}`
      : variant === 'danger'
        ? `1px solid ${colors.bear}`
        : `1px solid ${colors.border}`,
    borderRadius: 8,
    background: variant === 'primary'
      ? colors.accentDim
      : variant === 'danger'
        ? colors.bearDim
        : 'transparent',
    color: variant === 'primary'
      ? colors.accent
      : variant === 'danger'
        ? colors.bear
        : colors.text1,
    fontSize: 14,
    fontWeight: 600,
    fontFamily: "'Inter', sans-serif",
    cursor: 'pointer',
    transition: 'all 0.15s',
  }),
  badge: (color: string, bg: string) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '3px 10px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 700,
    fontFamily: "'JetBrains Mono', monospace",
    color,
    background: bg,
  }),
  card: {
    background: colors.bg0,
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    padding: 14,
    marginBottom: 12,
  },
  zone: {
    display: 'flex',
    gap: 8,
    marginBottom: 14,
    fontSize: 10,
    color: colors.text2,
  },
  zoneDot: (color: string) => ({
    width: 8,
    height: 8,
    borderRadius: 2,
    background: color,
    flexShrink: 0,
    marginTop: 2,
  }),
  progressBar: {
    height: 6,
    borderRadius: 3,
    background: colors.bg3,
    overflow: 'hidden' as const,
    marginTop: 8,
  },
  progressFill: (pct: number, color: string) => ({
    height: '100%',
    width: `${Math.min(pct, 100)}%`,
    background: color,
    borderRadius: 3,
    transition: 'width 0.4s ease',
  }),
  warning: {
    background: 'rgba(255,213,79,0.08)',
    border: `1px solid rgba(255,213,79,0.25)`,
    borderRadius: 8,
    padding: '12px 14px',
    fontSize: 12,
    color: colors.accent,
    lineHeight: 1.5,
    marginBottom: 16,
  },
  orderRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 0',
    borderBottom: `1px solid ${colors.bg3}`,
    fontSize: 12,
  },
};

// ── EIP-712 domain for HL approveAgent ──

const HL_DOMAIN = {
  name: 'HyperliquidSignTransaction' as const,
  version: '1' as const,
  chainId: 421614,
  verifyingContract: '0x0000000000000000000000000000000000000000' as `0x${string}`,
};

const APPROVE_AGENT_TYPES = {
  'HyperliquidTransaction:ApproveAgent': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'agentAddress', type: 'address' },
    { name: 'agentName', type: 'string' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

// ── Component ──

interface AutoBuyModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type Step = 1 | 2 | 3 | 4;

const COOLDOWN_OPTIONS = [
  { label: '1 hour', value: 3600 },
  { label: '4 hours', value: 14400 },
  { label: '12 hours', value: 43200 },
  { label: '24 hours', value: 86400 },
  { label: '7 days', value: 604800 },
];

export default function AutoBuyModal({ isOpen, onClose }: AutoBuyModalProps) {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { signTypedDataAsync } = useSignTypedData();

  // ── State ──
  const [step, setStep] = useState<Step>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [peData, setPeData] = useState<PEData | null>(null);
  const [agentAddress, setAgentAddress] = useState<string>('');
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);

  // Form state
  const [peTrigger, setPeTrigger] = useState(10);
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [marketType, setMarketType] = useState<'spot' | 'perp'>('spot');
  const [limitOffset, setLimitOffset] = useState(-2);
  const [amountUsdc, setAmountUsdc] = useState(500);
  const [maxTriggers, setMaxTriggers] = useState(3);
  const [totalBudget, setTotalBudget] = useState(2000);
  const [cooldown, setCooldown] = useState(14400);
  const [expiryDays, setExpiryDays] = useState(30);

  // ── Data loading ──

  const loadPE = useCallback(async () => {
    try {
      const data = await fetchCurrentPE();
      setPeData(data);
    } catch { /* silent */ }
  }, []);

  const loadAgentAddress = useCallback(async () => {
    try {
      const addr = await fetchAgentAddress();
      setAgentAddress(addr);
    } catch { /* silent */ }
  }, []);

  const loadStrategy = useCallback(async () => {
    if (!address) return;
    try {
      const s = await fetchStrategy(address);
      if (s) {
        setStrategy(s);
        setStep(4);
        const o = await fetchOrders(address);
        setOrders(o);
      }
    } catch { /* silent */ }
  }, [address]);

  useEffect(() => {
    if (!isOpen) return;
    loadPE();
    loadAgentAddress();
    const interval = setInterval(loadPE, 30000);
    return () => clearInterval(interval);
  }, [isOpen, loadPE, loadAgentAddress]);

  useEffect(() => {
    if (isConnected && address) {
      loadStrategy();
      if (step === 1) setStep(2);
    } else {
      setStep(1);
      setStrategy(null);
    }
  }, [isConnected, address, loadStrategy]);

  // ── Handlers ──

  const handleConnect = (connectorId: string) => {
    const connector = connectors.find(c => c.id === connectorId) || connectors[0];
    if (connector) connect({ connector });
  };

  const handleSign = async () => {
    if (!address || !agentAddress) return;
    setLoading(true);
    setError('');

    try {
      const nonce = Date.now();

      // Sign EIP-712 approveAgent
      const signature = await signTypedDataAsync({
        domain: HL_DOMAIN,
        types: APPROVE_AGENT_TYPES,
        primaryType: 'HyperliquidTransaction:ApproveAgent',
        message: {
          hyperliquidChain: 'Mainnet',
          agentAddress: agentAddress as `0x${string}`,
          agentName: 'Hypurrmium AutoBuy',
          nonce: BigInt(nonce),
        },
      });

      // Send approveAgent to Hyperliquid exchange from frontend
      const approveRes = await fetch('https://api.hyperliquid.xyz/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: {
            type: 'approveAgent',
            hyperliquidChain: 'Mainnet',
            agentAddress,
            agentName: 'Hypurrmium AutoBuy',
            nonce,
          },
          nonce,
          signature: {
            r: signature.slice(0, 66),
            s: '0x' + signature.slice(66, 130),
            v: parseInt(signature.slice(130, 132), 16),
          },
          vaultAddress: null,
        }),
      });

      const approveData = await approveRes.json();
      if (approveData.status === 'err') throw new Error(approveData.response || 'Agent approval failed on Hyperliquid');

      // Build config
      const expiresAt = new Date(Date.now() + expiryDays * 86400 * 1000).toISOString();
      const config: StrategyConfig = {
        pe_trigger: peTrigger,
        order_type: orderType,
        limit_offset_pct: orderType === 'limit' ? limitOffset : undefined,
        amount_usdc: amountUsdc,
        max_triggers: maxTriggers,
        total_budget: totalBudget,
        cooldown_seconds: cooldown,
        expires_at: expiresAt,
        market_type: marketType,
      };

      // Register on backend
      const strat = await createStrategy(address, signature, nonce, config);
      setStrategy(strat);
      setStep(4);

      // Load orders
      const o = await fetchOrders(address);
      setOrders(o);
    } catch (err: any) {
      setError(err.message || 'Signing failed');
    } finally {
      setLoading(false);
    }
  };

  const handlePause = async () => {
    if (!address || !strategy) return;
    setLoading(true);
    try {
      if (strategy.active) {
        await pauseStrategy(address);
      } else {
        await resumeStrategy(address);
      }
      await loadStrategy();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async () => {
    if (!address) return;
    if (!window.confirm('Revoke agent authorization? You will need to re-sign to reactivate.')) return;
    setLoading(true);
    try {
      // Revoke on Hyperliquid (approveAgent with 0x0 address)
      const nonce = Date.now();
      const signature = await signTypedDataAsync({
        domain: HL_DOMAIN,
        types: APPROVE_AGENT_TYPES,
        primaryType: 'HyperliquidTransaction:ApproveAgent',
        message: {
          hyperliquidChain: 'Mainnet',
          agentAddress: '0x0000000000000000000000000000000000000000',
          agentName: '',
          nonce: BigInt(nonce),
        },
      });

      await fetch('https://api.hyperliquid.xyz/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: {
            type: 'approveAgent',
            hyperliquidChain: 'Mainnet',
            agentAddress: '0x0000000000000000000000000000000000000000',
            agentName: '',
            nonce,
          },
          nonce,
          signature: {
            r: signature.slice(0, 66),
            s: '0x' + signature.slice(66, 130),
            v: parseInt(signature.slice(130, 132), 16),
          },
          vaultAddress: null,
        }),
      });

      // Deactivate on backend
      await deleteStrategy(address);
      setStrategy(null);
      setStep(2);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Render ──

  if (!isOpen) return null;

  const peColor = peData
    ? peData.pe < 8 ? colors.bull : peData.pe > 20 ? colors.bear : colors.accent
    : colors.text2;

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={s.header}>
          <div style={s.title}>
            <span style={{ fontSize: 20 }}>⚡</span>
            Auto-Buy
            {peData && (
              <span style={s.badge(peColor, peColor === colors.bull ? colors.bullDim : peColor === colors.bear ? colors.bearDim : colors.accentDim)}>
                P/E {peData.pe.toFixed(1)}x
              </span>
            )}
          </div>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Step indicators */}
        <div style={{ padding: '12px 20px 0' }}>
          <div style={s.steps}>
            {[1, 2, 3, 4].map(i => (
              <div key={i} style={s.stepDot(step === i, step > i)} />
            ))}
          </div>
        </div>

        <div style={s.body}>
          {error && (
            <div style={{ ...s.warning, borderColor: 'rgba(224,82,82,0.4)', color: colors.bear, background: colors.bearDim }}>
              {error}
              <button
                onClick={() => setError('')}
                style={{ float: 'right', background: 'none', border: 'none', color: colors.bear, cursor: 'pointer', fontSize: 16 }}
              >✕</button>
            </div>
          )}

          {/* ── STEP 1: Connect Wallet ── */}
          {step === 1 && (
            <div>
              <div style={s.label}>Connect your Hyperliquid wallet</div>
              <p style={{ fontSize: 12, color: colors.text2, marginBottom: 16, lineHeight: 1.5 }}>
                Connect the wallet you use on Hyperliquid to set up automatic $HYPE purchases
                based on P/E ratio thresholds.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {connectors.map(connector => (
                  <button
                    key={connector.id}
                    style={s.btn('secondary')}
                    onClick={() => handleConnect(connector.id)}
                  >
                    {connector.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── STEP 2: Configure Strategy ── */}
          {step === 2 && (
            <div>
              {/* Connected address */}
              <div style={{ ...s.card, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={s.label}>Connected</div>
                  <div style={{ ...s.value, fontSize: 12 }}>
                    {address?.slice(0, 6)}...{address?.slice(-4)}
                  </div>
                </div>
                <button
                  style={{ ...s.btn('secondary'), width: 'auto', padding: '6px 12px', fontSize: 11 }}
                  onClick={() => disconnect()}
                >
                  Disconnect
                </button>
              </div>

              {/* P/E Reference zones */}
              <div style={s.zone}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div style={s.zoneDot(colors.bull)} /> Cheap &lt;8x
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div style={s.zoneDot('#f0b90b')} /> Fair 12-14x
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div style={s.zoneDot(colors.bear)} /> Expensive &gt;20x
                </div>
              </div>

              {/* P/E Trigger */}
              <div style={s.field}>
                <div style={s.label}>P/E Trigger — Buy when below</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="number"
                    style={{ ...s.input, flex: 1 }}
                    value={peTrigger}
                    onChange={e => setPeTrigger(parseFloat(e.target.value) || 0)}
                    min={1}
                    max={100}
                    step={0.5}
                  />
                  <span style={{ ...s.value, color: colors.accent }}>×</span>
                </div>
                {peData && (
                  <div style={{ fontSize: 10, color: colors.text2, marginTop: 4 }}>
                    Current P/E: <span style={{ color: peColor }}>{peData.pe.toFixed(1)}x</span>
                    {peData.pe < peTrigger && (
                      <span style={{ color: colors.bull, marginLeft: 8 }}>⚡ Would trigger now!</span>
                    )}
                  </div>
                )}
              </div>

              {/* Order Type */}
              <div style={s.row}>
                <div>
                  <div style={s.label}>Order Type</div>
                  <select
                    style={s.select}
                    value={orderType}
                    onChange={e => setOrderType(e.target.value as 'market' | 'limit')}
                  >
                    <option value="market">Market (IOC)</option>
                    <option value="limit">Limit (GTC)</option>
                  </select>
                </div>
                {orderType === 'limit' && (
                  <div>
                    <div style={s.label}>Limit Offset %</div>
                    <input
                      type="number"
                      style={s.input}
                      value={limitOffset}
                      onChange={e => setLimitOffset(parseFloat(e.target.value) || 0)}
                      max={0}
                      step={0.5}
                    />
                  </div>
                )}
                <div>
                  <div style={s.label}>Market</div>
                  <select
                    style={s.select}
                    value={marketType}
                    onChange={e => setMarketType(e.target.value as 'spot' | 'perp')}
                  >
                    <option value="spot">Spot</option>
                    <option value="perp">Perp</option>
                  </select>
                </div>
              </div>

              {/* Amount + Max Triggers */}
              <div style={s.row}>
                <div>
                  <div style={s.label}>Amount per trigger (USDC)</div>
                  <input
                    type="number"
                    style={s.input}
                    value={amountUsdc}
                    onChange={e => setAmountUsdc(parseFloat(e.target.value) || 0)}
                    min={10}
                    step={50}
                  />
                </div>
                <div>
                  <div style={s.label}>Max triggers</div>
                  <input
                    type="number"
                    style={s.input}
                    value={maxTriggers}
                    onChange={e => setMaxTriggers(parseInt(e.target.value) || 1)}
                    min={1}
                    max={100}
                  />
                </div>
              </div>

              {/* Budget + Cooldown */}
              <div style={s.row}>
                <div>
                  <div style={s.label}>Total budget (USDC)</div>
                  <input
                    type="number"
                    style={s.input}
                    value={totalBudget}
                    onChange={e => setTotalBudget(parseFloat(e.target.value) || 0)}
                    min={amountUsdc}
                    step={100}
                  />
                </div>
                <div>
                  <div style={s.label}>Cooldown</div>
                  <select
                    style={s.select}
                    value={cooldown}
                    onChange={e => setCooldown(parseInt(e.target.value))}
                  >
                    {COOLDOWN_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Expiry */}
              <div style={s.field}>
                <div style={s.label}>Strategy expiry (days from now)</div>
                <input
                  type="number"
                  style={s.input}
                  value={expiryDays}
                  onChange={e => setExpiryDays(parseInt(e.target.value) || 7)}
                  min={1}
                  max={365}
                />
              </div>

              {/* Summary */}
              <div style={s.card}>
                <div style={{ fontSize: 11, color: colors.text2, marginBottom: 6 }}>STRATEGY SUMMARY</div>
                <div style={{ fontSize: 12, color: colors.text1, lineHeight: 1.8 }}>
                  Buy <span style={{ color: colors.accent }}>${amountUsdc}</span> of HYPE
                  {' '}when P/E drops below <span style={{ color: colors.bull }}>{peTrigger}x</span>
                  <br />
                  Up to <span style={{ color: colors.accent }}>{maxTriggers}×</span>
                  {' '}· Max budget <span style={{ color: colors.accent }}>${totalBudget}</span>
                  {' '}· Cooldown {COOLDOWN_OPTIONS.find(o => o.value === cooldown)?.label}
                  <br />
                  {orderType === 'market' ? 'Market order (IOC)' : `Limit order at ${limitOffset}% from price`}
                  {' '}· {marketType === 'spot' ? 'Spot' : 'Perp'}
                  {' '}· Expires in {expiryDays} days
                </div>
              </div>

              <button
                style={s.btn('primary')}
                onClick={() => setStep(3)}
              >
                Continue → Authorize Agent
              </button>
            </div>
          )}

          {/* ── STEP 3: Sign Authorization ── */}
          {step === 3 && (
            <div>
              <div style={s.warning}>
                <strong>🔐 What you are authorizing:</strong>
                <br /><br />
                You authorize <strong>Hypurrmium</strong> to place <strong>buy orders for $HYPE</strong> on
                your behalf on Hyperliquid, within the limits you configured:
                <br /><br />
                • Max <strong>${totalBudget} USDC</strong> total
                <br />
                • Max <strong>{maxTriggers}</strong> orders
                <br />
                • Only when P/E &lt; <strong>{peTrigger}x</strong>
                <br /><br />
                <strong>Hypurrmium CANNOT withdraw your funds.</strong>
                {' '}The agent can only place and cancel orders. Your funds stay in your
                Hyperliquid account at all times.
                <br /><br />
                You can revoke this authorization at any time.
              </div>

              <div style={{ ...s.card, fontSize: 11 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ color: colors.text2 }}>Agent Address</span>
                  <span style={{ color: colors.text1, fontFamily: "'JetBrains Mono', monospace" }}>
                    {agentAddress ? `${agentAddress.slice(0, 8)}...${agentAddress.slice(-6)}` : 'Loading...'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ color: colors.text2 }}>Agent Name</span>
                  <span style={{ color: colors.accent }}>Hypurrmium AutoBuy</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: colors.text2 }}>Network</span>
                  <span style={{ color: colors.text1 }}>Hyperliquid Mainnet</span>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  style={{ ...s.btn('secondary'), flex: 1 }}
                  onClick={() => setStep(2)}
                  disabled={loading}
                >
                  ← Back
                </button>
                <button
                  style={{ ...s.btn('primary'), flex: 2, opacity: loading ? 0.6 : 1 }}
                  onClick={handleSign}
                  disabled={loading || !agentAddress}
                >
                  {loading ? 'Signing…' : '🔐 Authorize & Activate'}
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 4: Dashboard ── */}
          {step === 4 && strategy && (
            <div>
              {/* Status */}
              <div style={{ ...s.card, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={s.label}>Strategy Status</div>
                  <span style={s.badge(
                    strategy.active ? colors.bull : new Date(strategy.expires_at) < new Date() ? colors.text2 : colors.accent,
                    strategy.active ? colors.bullDim : new Date(strategy.expires_at) < new Date() ? colors.bg3 : colors.accentDim,
                  )}>
                    <span style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: strategy.active ? colors.bull : colors.text2,
                      display: 'inline-block',
                    }} />
                    {strategy.active
                      ? 'Active'
                      : new Date(strategy.expires_at) < new Date()
                        ? 'Expired'
                        : 'Paused'}
                  </span>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={s.label}>Trigger</div>
                  <div style={{ ...s.value, color: colors.bull }}>P/E &lt; {strategy.pe_trigger}x</div>
                </div>
              </div>

              {/* P/E Progress */}
              {peData && (
                <div style={s.card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={s.label}>Current P/E vs Trigger</div>
                      <div style={s.value}>
                        <span style={{ color: peColor }}>{peData.pe.toFixed(1)}x</span>
                        <span style={{ color: colors.text2, fontSize: 12 }}> / {strategy.pe_trigger}x</span>
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: peData.pe < strategy.pe_trigger ? colors.bull : colors.text2 }}>
                      {peData.pe < strategy.pe_trigger
                        ? '⚡ Below trigger!'
                        : `${((peData.pe - strategy.pe_trigger) / strategy.pe_trigger * 100).toFixed(0)}% above`}
                    </div>
                  </div>
                  <div style={s.progressBar}>
                    <div style={s.progressFill(
                      Math.min((strategy.pe_trigger / peData.pe) * 100, 100),
                      peData.pe < strategy.pe_trigger ? colors.bull : colors.accent,
                    )} />
                  </div>
                </div>
              )}

              {/* Budget usage */}
              <div style={s.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div>
                    <div style={s.label}>Budget Used</div>
                    <div style={s.value}>${strategy.budget_used.toFixed(0)} / ${strategy.total_budget}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={s.label}>Triggers</div>
                    <div style={s.value}>{strategy.triggers_used} / {strategy.max_triggers}</div>
                  </div>
                </div>
                <div style={s.progressBar}>
                  <div style={s.progressFill(
                    (strategy.budget_used / strategy.total_budget) * 100,
                    colors.accent,
                  )} />
                </div>
                <div style={{ fontSize: 10, color: colors.text2, marginTop: 6 }}>
                  {strategy.order_type === 'market' ? 'Market' : `Limit (${strategy.limit_offset_pct}%)`}
                  {' · '}${strategy.amount_usdc}/order
                  {' · '}Cooldown: {COOLDOWN_OPTIONS.find(o => o.value === strategy.cooldown_seconds)?.label || `${strategy.cooldown_seconds}s`}
                  {' · '}Expires: {new Date(strategy.expires_at).toLocaleDateString()}
                </div>
              </div>

              {/* Order history */}
              <div style={s.card}>
                <div style={s.label}>Order History</div>
                {orders.length === 0 ? (
                  <div style={{ fontSize: 11, color: colors.text2, padding: '8px 0', textAlign: 'center' }}>
                    No orders executed yet
                  </div>
                ) : (
                  orders.map(order => (
                    <div key={order.id} style={s.orderRow}>
                      <div>
                        <span style={{
                          color: order.status === 'filled' ? colors.bull : colors.bear,
                          fontWeight: 600,
                          fontFamily: "'JetBrains Mono', monospace",
                        }}>
                          {order.status === 'filled' ? '✓' : '✗'}
                        </span>
                        <span style={{ color: colors.text1, marginLeft: 8 }}>
                          {order.size_hype.toFixed(2)} HYPE
                        </span>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <span style={{ color: colors.text2, fontFamily: "'JetBrains Mono', monospace" }}>
                          ${order.amount_usdc.toFixed(0)} @ ${order.price.toFixed(2)}
                        </span>
                        <br />
                        <span style={{ fontSize: 10, color: colors.text2 }}>
                          P/E {order.pe_at_trigger.toFixed(1)}x · {new Date(order.created_at).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  style={{ ...s.btn('secondary'), flex: 1, opacity: loading ? 0.6 : 1 }}
                  onClick={handlePause}
                  disabled={loading}
                >
                  {strategy.active ? '⏸ Pause' : '▶ Resume'}
                </button>
                <button
                  style={{ ...s.btn('danger'), flex: 1, opacity: loading ? 0.6 : 1 }}
                  onClick={handleRevoke}
                  disabled={loading}
                >
                  🗑 Revoke Agent
                </button>
              </div>

              {/* Edit */}
              <button
                style={{ ...s.btn('secondary'), marginTop: 8 }}
                onClick={() => {
                  // Pre-fill form from existing strategy
                  setPeTrigger(strategy.pe_trigger);
                  setOrderType(strategy.order_type as 'market' | 'limit');
                  setMarketType((strategy as any).market_type || 'spot');
                  setLimitOffset(strategy.limit_offset_pct || -2);
                  setAmountUsdc(strategy.amount_usdc);
                  setMaxTriggers(strategy.max_triggers);
                  setTotalBudget(strategy.total_budget);
                  setCooldown(strategy.cooldown_seconds);
                  setStep(2);
                }}
              >
                ✏️ Edit Strategy
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
