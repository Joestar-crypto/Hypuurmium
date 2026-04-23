function normalizeBackendOrigin(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return raw.replace(/\/api$/i, '');
}

const DEFILLAMA_API_ROOT = 'https://api.llama.fi';
const COINGECKO_API_ROOT = 'https://api.coingecko.com/api/v3';
const COINS_LLAMA_API_ROOT = 'https://coins.llama.fi';
const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
const HYPERLIQUID_EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';
const DEFILLAMA_PROTOCOL_TTL_MS = 30 * 60 * 1000;
const COINGECKO_SIMPLE_PRICE_TTL_MS = 90 * 1000;
const COINGECKO_MARKET_CHART_TTL_MS = 30 * 60 * 1000;
const WORKER_JSON_CACHE = new Map();

function normalizeUpstreamSegment(value, fallback = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  return /^[a-z0-9-]+$/.test(normalized) ? normalized : fallback;
}

function normalizeAlphaSegment(value, fallback = 'usd') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  return /^[a-z]+$/.test(normalized) ? normalized : fallback;
}

function normalizeBooleanFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function normalizeCoinGeckoDays(value, fallback = '365') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'max') return 'max';
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return String(Math.min(parsed, 3650));
}

function buildDirectProxyTarget(incomingUrl, proxiedPath) {
  if (proxiedPath === '/defillama/fees') {
    const slug = normalizeUpstreamSegment(incomingUrl.searchParams.get('slug'), 'hyperliquid');
    const dataType = String(incomingUrl.searchParams.get('dataType') || 'dailyRevenue').trim() || 'dailyRevenue';
    const params = new URLSearchParams({ dataType });
    return `${DEFILLAMA_API_ROOT}/summary/fees/${slug}?${params.toString()}`;
  }

  if (proxiedPath === '/defillama/protocol') {
    const slug = normalizeUpstreamSegment(incomingUrl.searchParams.get('slug'), 'hyperliquid');
    return `${DEFILLAMA_API_ROOT}/protocol/${slug}`;
  }

  if (proxiedPath === '/coingecko/coin') {
    const id = normalizeUpstreamSegment(incomingUrl.searchParams.get('id'), 'lighter');
    return `${COINGECKO_API_ROOT}/coins/${id}`;
  }

  if (proxiedPath === '/coingecko/simple/price') {
    const ids = normalizeUpstreamSegment(incomingUrl.searchParams.get('ids'), 'lighter');
    const vsCurrencies = normalizeAlphaSegment(incomingUrl.searchParams.get('vs_currencies'), 'usd');
    const params = new URLSearchParams({
      ids,
      vs_currencies: vsCurrencies,
      include_market_cap: normalizeBooleanFlag(incomingUrl.searchParams.get('include_market_cap')) ? 'true' : 'false',
      include_24hr_change: normalizeBooleanFlag(incomingUrl.searchParams.get('include_24hr_change')) ? 'true' : 'false',
    });
    return `${COINGECKO_API_ROOT}/simple/price?${params.toString()}`;
  }

  if (proxiedPath === '/coingecko/market_chart') {
    const id = normalizeUpstreamSegment(incomingUrl.searchParams.get('id'), 'lighter');
    const vsCurrency = normalizeAlphaSegment(incomingUrl.searchParams.get('vs_currency'), 'usd');
    const params = new URLSearchParams({
      vs_currency: vsCurrency,
      days: normalizeCoinGeckoDays(incomingUrl.searchParams.get('days'), '365'),
    });
    const interval = normalizeAlphaSegment(incomingUrl.searchParams.get('interval'), '');
    if (interval) params.set('interval', interval);
    return `${COINGECKO_API_ROOT}/coins/${id}/market_chart?${params.toString()}`;
  }

  if (proxiedPath === '/hl-info') {
    return `${HYPERLIQUID_INFO_URL}${incomingUrl.search}`;
  }

  if (proxiedPath === '/hl-exchange') {
    return `${HYPERLIQUID_EXCHANGE_URL}${incomingUrl.search}`;
  }

  return null;
}

function getCachedWorkerJson(cacheKey, ttlMs) {
  if (!cacheKey || !ttlMs) return null;
  const cached = WORKER_JSON_CACHE.get(cacheKey);
  if (!cached) return null;
  return cached.expiresAt > Date.now() ? cached : cached;
}

function setCachedWorkerJson(cacheKey, data, ttlMs) {
  if (!cacheKey || !ttlMs) return;
  WORKER_JSON_CACHE.set(cacheKey, {
    data,
    expiresAt: Date.now() + ttlMs,
  });
}

function summarizeDefiLlamaProtocol(data) {
  if (!data || typeof data !== 'object') return {};

  return {
    id: data.id ?? null,
    name: data.name ?? null,
    symbol: data.symbol ?? null,
    gecko_id: data.gecko_id ?? null,
    mcap: data.mcap ?? null,
    fdv: data.fdv ?? null,
  };
}

async function fetchJsonStrict(url) {
  const response = await fetch(url, { redirect: 'manual' });
  const raw = await response.text();
  if (!response.ok) {
    const error = new Error(`Upstream request failed (${response.status}) for ${url}`);
    error.status = response.status;
    error.detail = raw;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    const parseError = new Error(`Upstream returned invalid JSON for ${url}`);
    parseError.status = 502;
    parseError.detail = raw;
    throw parseError;
  }
}

async function fetchCachedJsonWithFallback(url, { cacheKey = url, ttlMs = 0, fallback = null } = {}) {
  const cached = getCachedWorkerJson(cacheKey, ttlMs);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  try {
    const data = await fetchJsonStrict(url);
    setCachedWorkerJson(cacheKey, data, ttlMs);
    return data;
  } catch (error) {
    if (typeof fallback === 'function') {
      try {
        const fallbackData = await fallback(error, cached?.data || null);
        if (fallbackData) {
          setCachedWorkerJson(cacheKey, fallbackData, ttlMs);
          return fallbackData;
        }
      } catch (fallbackError) {}
    }
    if (cached?.data) return cached.data;
    throw error;
  }
}

async function fetchCoinsLlamaCurrentPriceFallback(incomingUrl) {
  const id = normalizeUpstreamSegment(incomingUrl.searchParams.get('ids') || incomingUrl.searchParams.get('id'), 'lighter');
  const data = await fetchJsonStrict(`${COINS_LLAMA_API_ROOT}/prices/current/coingecko:${id}`);
  const entry = data?.coins?.[`coingecko:${id}`];
  const price = Number(entry?.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    [id]: {
      usd: price,
      usd_market_cap: null,
      usd_24hr_change: null,
    },
  };
}

async function fetchCoinsLlamaChartFallback(incomingUrl) {
  const id = normalizeUpstreamSegment(incomingUrl.searchParams.get('id'), 'lighter');
  const span = normalizeCoinGeckoDays(incomingUrl.searchParams.get('days'), '365');
  const params = new URLSearchParams({
    span: span === 'max' ? '365' : span,
    period: '1d',
  });
  const data = await fetchJsonStrict(`${COINS_LLAMA_API_ROOT}/chart/coingecko:${id}?${params.toString()}`);
  const points = data?.coins?.[`coingecko:${id}`]?.prices;
  if (!Array.isArray(points) || !points.length) return null;
  return {
    prices: points
      .map((point) => {
        const timestamp = Number(point?.timestamp);
        const price = Number(point?.price);
        if (!Number.isFinite(timestamp) || !Number.isFinite(price) || price <= 0) return null;
        return [timestamp * 1000, price];
      })
      .filter(Boolean),
    market_caps: [],
    total_volumes: [],
  };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function buildProxyHeaders(requestHeaders, incomingUrl) {
  const headers = new Headers(requestHeaders);
  headers.delete('host');
  headers.set('x-forwarded-host', incomingUrl.host);
  headers.set('x-forwarded-proto', incomingUrl.protocol.replace(':', ''));
  return headers;
}

async function proxyRequest(targetUrl, context) {
  const incomingUrl = new URL(context.request.url);
  const requestBody = context.request.method === 'GET' || context.request.method === 'HEAD'
    ? undefined
    : await context.request.arrayBuffer();
  const upstreamResponse = await fetch(targetUrl, {
    method: context.request.method,
    headers: buildProxyHeaders(context.request.headers, incomingUrl),
    body: requestBody,
    redirect: 'manual',
  });

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: upstreamResponse.headers,
  });
}

export async function onRequest(context) {
  const incomingUrl = new URL(context.request.url);
  const proxiedPath = incomingUrl.pathname.replace(/^\/api/i, '');

  if (proxiedPath === '/coingecko/simple/price') {
    try {
      const data = await fetchCachedJsonWithFallback(buildDirectProxyTarget(incomingUrl, proxiedPath), {
        cacheKey: `coingecko:simple:${normalizeUpstreamSegment(incomingUrl.searchParams.get('ids'), 'lighter')}:${normalizeAlphaSegment(incomingUrl.searchParams.get('vs_currencies'), 'usd')}`,
        ttlMs: COINGECKO_SIMPLE_PRICE_TTL_MS,
        fallback: () => fetchCoinsLlamaCurrentPriceFallback(incomingUrl),
      });
      return jsonResponse(data, 200);
    } catch (error) {
      return jsonResponse({
        error: 'Failed to reach upstream market data provider from Cloudflare proxy.',
        detail: error && error.message ? error.message : 'Unknown proxy error',
      }, error?.status || 502);
    }
  }

  if (proxiedPath === '/coingecko/market_chart') {
    try {
      const data = await fetchCachedJsonWithFallback(buildDirectProxyTarget(incomingUrl, proxiedPath), {
        cacheKey: `coingecko:market_chart:${normalizeUpstreamSegment(incomingUrl.searchParams.get('id'), 'lighter')}:${normalizeCoinGeckoDays(incomingUrl.searchParams.get('days'), '365')}`,
        ttlMs: COINGECKO_MARKET_CHART_TTL_MS,
        fallback: () => fetchCoinsLlamaChartFallback(incomingUrl),
      });
      return jsonResponse(data, 200);
    } catch (error) {
      return jsonResponse({
        error: 'Failed to reach upstream market data provider from Cloudflare proxy.',
        detail: error && error.message ? error.message : 'Unknown proxy error',
      }, error?.status || 502);
    }
  }

  if (proxiedPath === '/defillama/protocol') {
    try {
      const slug = normalizeUpstreamSegment(incomingUrl.searchParams.get('slug'), 'hyperliquid');
      const data = await fetchCachedJsonWithFallback(buildDirectProxyTarget(incomingUrl, proxiedPath), {
        cacheKey: `defillama:protocol:${slug}`,
        ttlMs: DEFILLAMA_PROTOCOL_TTL_MS,
      });
      return jsonResponse(summarizeDefiLlamaProtocol(data), 200);
    } catch (error) {
      return jsonResponse({
        error: 'Failed to reach upstream market data provider from Cloudflare proxy.',
        detail: error && error.message ? error.message : 'Unknown proxy error',
      }, error?.status || 502);
    }
  }

  const directTarget = buildDirectProxyTarget(incomingUrl, proxiedPath);
  if (directTarget) {
    try {
      return await proxyRequest(directTarget, context);
    } catch (error) {
      return jsonResponse({
        error: 'Failed to reach upstream market data provider from Cloudflare proxy.',
        detail: error && error.message ? error.message : 'Unknown proxy error',
        targetUrl: directTarget,
      }, 502);
    }
  }

  const backendOrigin = normalizeBackendOrigin(context.env.BACKEND_ORIGIN);
  if (!backendOrigin) {
    return jsonResponse({
      error: 'BACKEND_ORIGIN is not configured in Cloudflare Pages/Workers.',
    }, 500);
  }

  const targetUrl = `${backendOrigin}/api${proxiedPath}${incomingUrl.search}`;

  try {
    return await proxyRequest(targetUrl, context);
  } catch (error) {
    return jsonResponse({
      error: 'Failed to reach backend origin from Cloudflare proxy.',
      detail: error && error.message ? error.message : 'Unknown proxy error',
      targetUrl,
    }, 502);
  }
}