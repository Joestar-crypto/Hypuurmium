function normalizeBackendOrigin(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return raw.replace(/\/api$/i, '');
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

export async function onRequest(context) {
  const backendOrigin = normalizeBackendOrigin(context.env.BACKEND_ORIGIN);
  if (!backendOrigin) {
    return jsonResponse({
      error: 'BACKEND_ORIGIN is not configured in Cloudflare Pages/Workers.',
    }, 500);
  }

  const incomingUrl = new URL(context.request.url);
  const proxiedPath = incomingUrl.pathname.replace(/^\/api/i, '');
  const targetUrl = `${backendOrigin}/api${proxiedPath}${incomingUrl.search}`;

  const headers = new Headers(context.request.headers);
  headers.set('x-forwarded-host', incomingUrl.host);
  headers.set('x-forwarded-proto', incomingUrl.protocol.replace(':', ''));

  try {
    const upstreamResponse = await fetch(targetUrl, {
      method: context.request.method,
      headers,
      body: context.request.method === 'GET' || context.request.method === 'HEAD'
        ? undefined
        : context.request.body,
      redirect: 'manual',
    });

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: upstreamResponse.headers,
    });
  } catch (error) {
    return jsonResponse({
      error: 'Failed to reach backend origin from Cloudflare proxy.',
      detail: error && error.message ? error.message : 'Unknown proxy error',
      targetUrl,
    }, 502);
  }
}