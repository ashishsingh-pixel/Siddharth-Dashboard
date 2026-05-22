import { refreshStore, getCache, response } from './lib/dataProcessor.mjs';
import * as config from './lib/config.mjs';

const CACHE_TTL_MS = (parseInt(process.env.CACHE_TTL_MINUTES || '4', 10) || 4) * 60 * 1000;
let memory = { data: null, at: 0 };

async function getData() {
  const now = Date.now();
  if (memory.data && now - memory.at < CACHE_TTL_MS) {
    return memory.data;
  }
  const fresh = await refreshStore();
  memory = { data: fresh, at: now };
  return fresh;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

export default async (req, context) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const apiIdx = parts.indexOf('api');
  const segment =
    apiIdx >= 0 && parts[apiIdx + 1] ? parts[apiIdx + 1].replace(/\/$/, '') : 'health';

  try {
    if (segment === 'health') {
      try {
        const data = await getData();
        return json(200, {
          success: true,
          updated_at: getCache().cacheAt,
          status: 'ok',
          last_error: null,
          gm_name: config.GM_NAME,
          payment_month: config.PAYMENT_MONTH,
          refresh_interval_minutes: parseInt(process.env.CACHE_TTL_MINUTES || '4', 10),
          leads: data.leadRows?.length,
          tokens: data.tokenRows?.length,
          full_payments: data.fullRows?.length,
        });
      } catch (e) {
        return json(503, {
          success: false,
          status: 'degraded',
          last_error: String(e.message),
          gm_name: config.GM_NAME,
        });
      }
    }

    if (segment === 'refresh' && req.method === 'POST') {
      memory = { data: null, at: 0 };
      await getData();
      return json(200, response(true, { message: 'Refresh complete' }, getCache().cacheAt));
    }

    const data = await getData();
    const updatedAt = getCache().cacheAt;

    if (segment === 'dashboard') {
      return json(200, response(true, data.dashboard, updatedAt));
    }
    if (segment === 'kpis') {
      return json(200, response(true, data.kpis, updatedAt));
    }
    if (segment === 'leads') {
      return json(200, response(true, data.leadRows, updatedAt));
    }
    if (segment === 'inputs') {
      return json(200, response(true, data.inputRows, updatedAt));
    }
    if (segment === 'tokens') {
      return json(200, response(true, data.tokenRows, updatedAt));
    }
    if (segment === 'fullpayments') {
      return json(200, response(true, data.fullRows, updatedAt));
    }

    return json(404, response(false, null, updatedAt, `Unknown API path: ${segment}`));
  } catch (err) {
    console.error('API error:', err);
    return json(503, response(false, null, getCache().cacheAt, err.message || String(err)));
  }
};
