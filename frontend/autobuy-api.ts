/**
 * Hypurrmium Auto-Buy — React hooks for API interaction
 */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// ── Types ──

export interface StrategyConfig {
  pe_trigger: number;
  order_type: 'market' | 'limit';
  limit_offset_pct?: number;
  amount_usdc: number;
  max_triggers: number;
  total_budget: number;
  cooldown_seconds: number;
  expires_at: string;
  market_type?: 'spot' | 'perp';
}

export interface Strategy {
  id: number;
  address: string;
  agent_authorized: number;
  pe_trigger: number;
  order_type: string;
  limit_offset_pct: number | null;
  amount_usdc: number;
  max_triggers: number;
  triggers_used: number;
  total_budget: number;
  budget_used: number;
  cooldown_seconds: number;
  last_triggered_at: string | null;
  expires_at: string;
  active: number;
  created_at: string;
}

export interface Order {
  id: number;
  strategy_id: number;
  address: string;
  pe_at_trigger: number;
  price: number;
  size_hype: number;
  amount_usdc: number;
  order_type: string;
  hl_response: string;
  status: string;
  created_at: string;
}

export interface PEData {
  pe: number;
  price: number;
  dailyRevenue: number;
  annualizedRevenue: number;
}

// ── API calls ──

export async function fetchAgentAddress(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/agent-address`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to fetch agent address');
  return data.agentAddress;
}

export async function fetchCurrentPE(): Promise<PEData> {
  const res = await fetch(`${API_BASE}/api/pe`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to fetch P/E');
  return data;
}

export async function createStrategy(
  address: string,
  signature: string,
  nonce: number,
  config: StrategyConfig
): Promise<Strategy> {
  const res = await fetch(`${API_BASE}/api/strategies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, signature, nonce, config }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to create strategy');
  return data.strategy;
}

export async function fetchStrategy(address: string): Promise<Strategy | null> {
  const res = await fetch(`${API_BASE}/api/strategies/${address}`);
  if (res.status === 404) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to fetch strategy');
  return data.strategy;
}

export async function pauseStrategy(address: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/strategies/${address}/pause`, { method: 'PATCH' });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Failed to pause');
  }
}

export async function resumeStrategy(address: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/strategies/${address}/resume`, { method: 'PATCH' });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Failed to resume');
  }
}

export async function deleteStrategy(address: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/strategies/${address}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Failed to delete');
  }
}

export async function fetchOrders(address: string): Promise<Order[]> {
  const res = await fetch(`${API_BASE}/api/orders/${address}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to fetch orders');
  return data.orders;
}
