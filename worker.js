// Lumina API Worker v3
// Proxies Anthropic API requests + Web Push notifications

import { sendWebPush } from './push-crypto.js';

const ALLOWED_ORIGIN = 'https://gmennonna.github.io';

const ALLOWED_ORIGINS = new Set([
  'https://gmennonna.github.io',
]);

function corsHeaders(origin) {
  const o = ALLOWED_ORIGINS.has(origin) ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/') {
      return new Response('Lumina API Worker v3 OK', { headers: corsHeaders(origin) });
    }

    // ── POST /api/anthropic ──
    if (url.pathname === '/api/anthropic' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }); }

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      const data = await resp.text();
      return new Response(data, {
        status: resp.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    // ── POST /api/push ──
    // Body: { subscription: {...}, title: string, body: string, url?: string }
    if (url.pathname === '/api/push' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }); }

      const { subscription, title, body: msgBody, url: msgUrl } = body;
      if (!subscription?.endpoint || !subscription?.keys) {
        return new Response(JSON.stringify({ error: 'Missing subscription' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } });
      }

      try {
        await sendWebPush(
          subscription,
          { title, body: msgBody, url: msgUrl || '/lumina/' },
          env.VAPID_PUBLIC_KEY,
          env.VAPID_PRIVATE_KEY,
          'mailto:g.mennonna@gmail.com'
        );
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
};
