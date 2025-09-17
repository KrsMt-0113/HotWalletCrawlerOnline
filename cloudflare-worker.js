export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET,OPTIONS'
        }
      });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    if (!target) {
      return new Response('Missing url param', { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    // Forward browser-provided API key via custom header X-API-Key
    const browserKey = request.headers.get('X-API-Key');
    const headers = new Headers();
    if (browserKey) headers.set('API-Key', browserKey);

    const resp = await fetch(target, { method: 'GET', headers });
    const body = await resp.text();

    return new Response(body, {
      status: resp.status,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Content-Type': resp.headers.get('Content-Type') || 'text/plain; charset=utf-8'
      }
    });
  }
}


