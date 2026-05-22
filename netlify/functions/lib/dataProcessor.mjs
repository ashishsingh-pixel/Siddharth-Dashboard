import Papa from 'papaparse';
import * as config from './config.mjs';

function nowStr() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function response(success, data, updatedAt, error) {
  return {
    success,
    updated_at: updatedAt || nowStr(),
    data,
    ...(error ? { error } : {}),
  };
}

function cleanStr(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  return text || null;
}

function emailToName(email) {
  const e = cleanStr(email);
  if (!e || !e.includes('@')) return null;
  const local = e.split('@')[0];
  const parts = local.replace(/\./g, ' ').replace(/_/g, ' ').split(/\s+/);
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ') || null;
}

function toFloat(value, def = 0) {
  if (value == null || value === '') return def;
  const n = parseFloat(String(value).replace(/,/g, '').trim());
  return Number.isNaN(n) ? def : n;
}

function toInt(value, def = 0) {
  if (value == null || value === '') return def;
  const n = parseInt(String(value).replace(/,/g, '').trim(), 10);
  return Number.isNaN(n) ? def : Math.round(parseFloat(String(value).replace(/,/g, '')) || def);
}

function parseDate(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  let d;
  if (/^\d{4}/.test(text)) {
    d = new Date(text);
  } else {
    const m = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (m) {
      let y = parseInt(m[3], 10);
      if (y < 100) y += 2000;
      d = new Date(y, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
    } else {
      d = new Date(text);
    }
  }
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function columnPresent(row, candidates) {
  if (!row) return null;
  for (const col of candidates) {
    if (col in row) return col;
  }
  return null;
}

function filterGm(rows) {
  if (!rows.length) return [];
  const gmCol = columnPresent(rows[0], config.GM_COLUMNS);
  if (!gmCol) return [];
  return rows.filter((r) => cleanStr(r[gmCol]) === config.GM_NAME);
}

function paymentMonthColumn(row) {
  // Two "Month" cols in sheet: 1st = label (April-26), 2nd = number (5) — Papa Parse names it Month_1
  if (row && 'Month_1' in row) return 'Month_1';
  if (row && 'Month.1' in row) return 'Month.1';
  if (row && 'Month' in row) return 'Month';
  return null;
}

function rowPaymentMonth(record, monthCol) {
  const raw = record[monthCol];
  if (raw == null || raw === '') return null;
  const n = parseFloat(String(raw).trim().replace(/,/g, ''));
  if (!Number.isNaN(n) && Number.isFinite(n)) return Math.round(n);
  return null;
}

function filterPaymentMonth(rows) {
  if (!rows.length) return [];
  const monthCol = paymentMonthColumn(rows[0]);
  if (!monthCol) return [];
  return rows.filter((r) => rowPaymentMonth(r, monthCol) === config.PAYMENT_MONTH);
}

function normalizeFinalStage(value) {
  const text = cleanStr(value);
  if (!text) return null;
  return text.replace(/ /g, '_');
}

function resolveLeadStage(record) {
  return normalizeFinalStage(record['Final Stage']);
}

async function fetchCsv(name, url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`CSV ${name} HTTP ${res.status}`);
    const text = await res.text();
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: 'greedy' });
    if (parsed.errors?.length) {
      console.warn(`CSV parse warnings for ${name}:`, parsed.errors.slice(0, 3));
    }
    return (parsed.data || []).filter((row) =>
      Object.values(row).some((v) => v != null && String(v).trim() !== '')
    );
  } finally {
    clearTimeout(t);
  }
}

function buildBdaManagerMap(leadRows) {
  const counts = {};
  for (const r of leadRows) {
    const bda = cleanStr(r['Owner (User Name)']);
    const mgr = cleanStr(r['Manager Name']);
    if (!bda || !mgr) continue;
    if (!counts[bda]) counts[bda] = {};
    counts[bda][mgr] = (counts[bda][mgr] || 0) + 1;
  }
  const map = {};
  for (const [bda, mgrCounts] of Object.entries(counts)) {
    let best = null;
    let bestN = 0;
    for (const [mgr, n] of Object.entries(mgrCounts)) {
      if (n > bestN) {
        bestN = n;
        best = mgr;
      }
    }
    if (best) map[bda] = best;
  }
  return map;
}

function processLeads(rows) {
  const out = [];
  for (const record of rows) {
    const date = parseDate(record['Created On']);
    const mgr = cleanStr(record['Manager Name']);
    const bda = cleanStr(record['Owner (User Name)']);
    const stage = resolveLeadStage(record);
    const source = cleanStr(record.Subsource) || '';
    if (!date || !mgr || !bda || !stage) continue;
    out.push({ date, mgr, bda, stage, source });
  }
  return out;
}

function processInputs(rows, bdaMgr) {
  const out = [];
  for (const record of rows) {
    const date = parseDate(record.Date);
    const bda = emailToName(record['Owner Name']);
    const mgr = cleanStr(record['Manager Name']) || (bda ? bdaMgr[bda] : null);
    if (!date || !bda || !mgr) continue;
    out.push({
      date,
      mgr,
      bda,
      calls: toInt(record['# Calls']),
      connected: toInt(record['# Calls Connected']),
      unique_leads: toInt(record['# Unique Leads']),
      tt: Math.round(toFloat(record['Total Call Duration']) * 100) / 100,
      outbound: toInt(record['# Outbound Calls']),
      inbound: toInt(record['# Inbound Calls']),
      outbound_ans: toInt(record['# Outbound Answered Calls']),
      inbound_ans: toInt(record['# Inbound Answered Calls']),
      dur_lt2: toInt(record['# Call Duration <2mins']),
      dur_2_5: toInt(record['# Call Duration >=2mins & <5mins']),
      dur_5_10: toInt(record['# Call Duration >=5mins & <10mins']),
      dur_10p: toInt(record['# Call Duration >=10mins']),
    });
  }
  return out;
}

function resolveTl(record) {
  for (const col of config.TL_COLUMNS) {
    const tl = cleanStr(record[col]);
    if (tl && config.MANAGERS.includes(tl)) return tl;
  }
  return config.UNASSIGNED_TL;
}

function processTokens(rows) {
  const out = [];
  for (const record of rows) {
    const bda = cleanStr(record.Agent);
    const course = cleanStr(record.Type);
    if (!bda || !course) continue;
    let amount = toFloat(record['Token Amount'], config.DEFAULT_TOKEN_AMOUNT);
    if (cleanStr(record['Token Amount']) == null) amount = config.DEFAULT_TOKEN_AMOUNT;
    out.push({ mgr: resolveTl(record), bda, amount, type: course });
  }
  return out;
}

function processFullPayments(rows) {
  const out = [];
  for (const record of rows) {
    const bda = cleanStr(record.Agent);
    const course = cleanStr(record.Type);
    const amount = toFloat(record['Amount Paid']);
    if (!bda || !course || amount <= 0) continue;
    out.push({ mgr: resolveTl(record), bda, amount, type: course });
  }
  return out;
}

function countByKey(rows, key) {
  const counts = {};
  for (const row of rows) {
    const v = row[key];
    if (!v) continue;
    counts[v] = (counts[v] || 0) + 1;
  }
  return counts;
}

function buildDailyCalls(inputRows) {
  const daily = {};
  for (const row of inputRows) {
    const date = row.date;
    if (!daily[date]) daily[date] = { calls: 0, connected: 0 };
    daily[date].calls += row.calls || 0;
    daily[date].connected += row.connected || 0;
  }
  return daily;
}

function computeKpis(leadRows, inputRows, tokenRows, fullRows) {
  const totalLeads = leadRows.length;
  const totalTokens = tokenRows.length;
  const totalFull = fullRows.length;
  const tokenRevenue = Math.round(tokenRows.reduce((s, r) => s + (r.amount || 0), 0) * 100) / 100;
  const fullRevenue = Math.round(fullRows.reduce((s, r) => s + (r.amount || 0), 0) * 100) / 100;
  return {
    total_leads: totalLeads,
    total_inputs: inputRows.length,
    total_token_payments: totalTokens,
    total_full_payments: totalFull,
    token_revenue: tokenRevenue,
    full_revenue: fullRevenue,
    total_revenue: Math.round((tokenRevenue + fullRevenue) * 100) / 100,
    lead_to_token_conversion_pct: totalLeads ? Math.round((totalTokens / totalLeads) * 10000) / 100 : 0,
    token_to_full_conversion_pct: totalTokens ? Math.round((totalFull / totalTokens) * 10000) / 100 : 0,
    overall_conversion_pct: totalLeads ? Math.round((totalFull / totalLeads) * 10000) / 100 : 0,
    avg_deal_size: totalFull ? Math.round((fullRevenue / totalFull) * 100) / 100 : 0,
  };
}

function buildDashboardPayload(leadRows, inputRows, tokenRows, fullRows) {
  const leadDates = leadRows.map((r) => r.date);
  const inputDates = inputRows.map((r) => r.date);
  const allDates = [...leadDates, ...inputDates];
  const dateMin = allDates.length ? allDates.reduce((a, b) => (a < b ? a : b)) : config.MONTH_START;
  const dateMax = allDates.length ? allDates.reduce((a, b) => (a > b ? a : b)) : config.MONTH_END;
  return {
    gm: config.GM_NAME,
    lead_rows: leadRows,
    input_rows: inputRows,
    token_rows: tokenRows,
    full_rows: fullRows,
    full_by_course: countByKey(fullRows, 'type'),
    token_by_course: countByKey(tokenRows, 'type'),
    leads_by_source: countByKey(leadRows, 'source'),
    daily_calls: buildDailyCalls(inputRows),
    date_min: dateMin,
    date_max: dateMax,
    input_date_min: inputDates.length ? inputDates.reduce((a, b) => (a < b ? a : b)) : null,
    input_date_max: inputDates.length ? inputDates.reduce((a, b) => (a > b ? a : b)) : null,
  };
}

let cache = null;
let cacheAt = null;

export async function refreshStore() {
  config.validateConfig();
  const frames = {};
  for (const [name, url] of Object.entries(config.CSV_URLS)) {
    frames[name] = await fetchCsv(name, url);
  }

  const leadsDf = filterGm(frames.leads);
  const inputsDf = filterGm(frames.inputs);
  const tokensDf = filterPaymentMonth(filterGm(frames.tokens));
  const fullDf = filterPaymentMonth(filterGm(frames.fullpayments));

  const bdaMgr = buildBdaManagerMap(leadsDf);
  const leadRows = processLeads(leadsDf);
  const inputRows = processInputs(inputsDf, bdaMgr);
  const tokenRows = processTokens(tokensDf);
  const fullRows = processFullPayments(fullDf);

  const dashboard = buildDashboardPayload(leadRows, inputRows, tokenRows, fullRows);
  const kpis = computeKpis(leadRows, inputRows, tokenRows, fullRows);

  cacheAt = nowStr();
  cache = { dashboard, kpis, leadRows, inputRows, tokenRows, fullRows };
  return cache;
}

export function getCache() {
  return { cache, cacheAt };
}
