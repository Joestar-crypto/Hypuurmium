function normalizeBackendOrigin(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return raw.replace(/\/api$/i, '');
}

const DEFILLAMA_FEES_URL = 'https://api.llama.fi/summary/fees/hyperliquid?dataType=dailyRevenue';
const DEFILLAMA_PROTOCOL_URL = 'https://api.llama.fi/protocol/hyperliquid';
const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
const HYPERLIQUID_EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';

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

  const directProxyTargets = {
    '/defillama/fees': DEFILLAMA_FEES_URL,
    '/defillama/protocol': DEFILLAMA_PROTOCOL_URL,
    '/hl-info': HYPERLIQUID_INFO_URL,
    '/hl-exchange': HYPERLIQUID_EXCHANGE_URL,
  };

  const directTarget = directProxyTargets[proxiedPath];
  if (directTarget) {
    try {
      return await proxyRequest(`${directTarget}${incomingUrl.search}`, context);
    } catch (error) {
      return jsonResponse({
        error: 'Failed to reach upstream market data provider from Cloudflare proxy.',
        detail: error && error.message ? error.message : 'Unknown proxy error',
        targetUrl: `${directTarget}${incomingUrl.search}`,
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