/** Runtime config from Netlify environment variables. */

function envInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function envFloat(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
}

export const GM_NAME = process.env.GM_NAME || 'Siddhartha';
export const PAYMENT_MONTH = envInt('PAYMENT_MONTH', 5);
export const DEFAULT_TOKEN_AMOUNT = envFloat('DEFAULT_TOKEN_AMOUNT', 5000);
export const REQUEST_TIMEOUT_MS = envInt('REQUEST_TIMEOUT', 30) * 1000;
export const UNASSIGNED_TL = process.env.UNASSIGNED_TL || 'Unassigned';
export const MONTH_START = process.env.MONTH_START || '2026-05-01';
export const MONTH_END = process.env.MONTH_END || '2026-05-31';

export const GM_COLUMNS = ['GM Name', 'GM'];
export const TL_COLUMNS = ['TL NAME', 'TL Name', 'TL'];

export const MANAGERS = (process.env.MANAGERS || 'Adnan,Sudhanshu,Shailendra,Bhavya')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const CSV_URLS = {
  leads: process.env.LEADS_CSV_URL || '',
  inputs: process.env.INPUTS_CSV_URL || '',
  tokens: process.env.TOKENS_CSV_URL || '',
  fullpayments: process.env.FULLPAYMENTS_CSV_URL || '',
};

export function validateConfig() {
  const missing = Object.entries(CSV_URLS)
    .filter(([, url]) => !url)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing CSV URL env vars: ${missing.join(', ')}`);
  }
}
