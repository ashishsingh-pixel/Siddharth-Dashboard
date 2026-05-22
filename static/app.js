// Live API integration layer
const API_BASE = window.location.origin;
let RAW = null;
let lastUpdatedAt = null;
const API_REFRESH_MS = 5 * 60 * 1000;

async function fetchJson(path) {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) throw new Error(`API ${path} failed (${response.status})`);
  const payload = await response.json();
  if (!payload.success) throw new Error(payload.error || `API ${path} returned success=false`);
  if (payload.updated_at) lastUpdatedAt = payload.updated_at;
  return payload.data;
}

async function loadDashboardData(silent=false) {
  if (!RAW && silent) return;
  const statusEl = document.getElementById('live-status');
  try {
    if (statusEl && !silent) statusEl.textContent = 'Loading live data...';
    const [dashboard, kpis] = await Promise.all([
      fetchJson('/api/dashboard'),
      fetchJson('/api/kpis'),
    ]);
    RAW = dashboard;
    if (RAW.date_min && RAW.date_max) {
      dateFrom = RAW.date_min;
      dateTo = RAW.date_max;
      syncDateInputs();
    }
    document.querySelectorAll('.date-preset').forEach(el => el.classList.remove('active'));
    const fullMonthBtn = document.querySelector('.date-preset[onclick*="all"]');
    if (fullMonthBtn) fullMonthBtn.classList.add('active');
    window.__DASHBOARD_KPIS = kpis;
    updateDateInfo();
    updateBDADropdown();
    render();
    if (statusEl) {
      statusEl.textContent = lastUpdatedAt
        ? `Live · updated ${lastUpdatedAt}`
        : 'Live';
    }
  } catch (err) {
    console.error(err);
    if (statusEl) statusEl.textContent = 'Refresh failed · retrying...';
  }
}

const MANAGERS = ['Adnan','Sudhanshu','Shailendra','Bhavya'];
const UNASSIGNED_TL = 'Unassigned';
const MGR_COLORS = {'Adnan':'#2563eb','Sudhanshu':'#db2777','Shailendra':'#0d9488','Bhavya':'#7c3aed',[UNASSIGNED_TL]:'#6b7280'};

let currentView = 'revenue';
let activeTL    = 'ALL';
let activeBDA   = 'ALL';
let stageChartMgr = 'ALL';
let stageChartHidden = new Set();
let stageChartStageKeys = [];
let stageChartStageTotals = {};
let dateFrom    = '2026-05-01';
let dateTo      = '2026-05-31';
let charts = {};

function dc(id){ if(charts[id]){charts[id].destroy();delete charts[id];} }
function fmt(n){ return Math.round(n).toLocaleString('en-IN'); }
function fmtRs(n){
  n=Math.round(n);
  if(n>=10000000) return '₹'+(n/10000000).toFixed(2)+'Cr';
  if(n>=100000)   return '₹'+(n/100000).toFixed(1)+'L';
  if(n>=1000)     return '₹'+(n/1000).toFixed(1)+'K';
  return '₹'+n.toLocaleString('en-IN');
}
function pct(a,b){ return b?(a/b*100).toFixed(1)+'%':'0%'; }

// ── DATE HELPERS ──────────────────────────────────────────
function monthBounds(){
  const min=RAW?.date_min||'2026-05-01';
  const max=RAW?.date_max||'2026-05-31';
  return {min,max};
}

function syncDateInputs(){
  const {min,max}=monthBounds();
  const fromEl=document.getElementById('date-from');
  const toEl=document.getElementById('date-to');
  fromEl.min=min; fromEl.max=max;
  toEl.min=min; toEl.max=max;
  if(dateFrom<min) dateFrom=min;
  if(dateTo>max) dateTo=max;
  if(dateFrom>dateTo) dateFrom=dateTo;
  fromEl.value=dateFrom;
  toEl.value=dateTo;
}

function inRange(d){ return d >= dateFrom && d <= dateTo; }

function setPreset(p, el){
  document.querySelectorAll('.date-preset').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  const {min,max}=monthBounds();
  const end=new Date(max);
  if(p==='1w'){
    const start=new Date(end);
    start.setDate(start.getDate()-6);
    dateFrom=start.toISOString().slice(0,10);
    dateTo=max;
  } else if(p==='2w'){
    const start=new Date(end);
    start.setDate(start.getDate()-13);
    dateFrom=start.toISOString().slice(0,10);
    dateTo=max;
  } else {
    dateFrom=min;
    dateTo=max;
  }
  if(dateFrom<min) dateFrom=min;
  syncDateInputs();
  updateDateInfo(); render();
}

function onDateChange(){
  dateFrom = document.getElementById('date-from').value;
  dateTo   = document.getElementById('date-to').value;
  const {min,max}=monthBounds();
  if(dateFrom<min) dateFrom=min;
  if(dateTo>max) dateTo=max;
  if(dateFrom > dateTo){ dateTo=dateFrom; }
  syncDateInputs();
  document.querySelectorAll('.date-preset').forEach(b=>b.classList.remove('active'));
  updateDateInfo(); render();
}

function updateDateInfo(){
  const from = dateFrom.slice(5), to = dateTo.slice(5);
  const days = Math.round((new Date(dateTo)-new Date(dateFrom))/86400000)+1;
  document.getElementById('date-range-info').textContent = from===to ? '('+days+' day)' : '('+days+' days)';
}

// ── FILTERED DATA ────────────────────────────────────────
function filteredInputRows(){
  return RAW.input_rows.filter(r=>
    inRange(r.date) &&
    (activeTL==='ALL' || r.mgr===activeTL) &&
    (activeBDA==='ALL' || r.bda===activeBDA)
  );
}

function filteredLeadRows(){
  return RAW.lead_rows.filter(r=>
    inRange(r.date) &&
    (activeTL==='ALL' || r.mgr===activeTL) &&
    (activeBDA==='ALL' || r.bda===activeBDA)
  );
}

function filteredLeadRowsForStageChart(){
  return RAW.lead_rows.filter(r=>
    inRange(r.date) &&
    (stageChartMgr==='ALL' || r.mgr===stageChartMgr) &&
    (activeBDA==='ALL' || r.bda===activeBDA)
  );
}

function aggInputsByMgr(rows){
  const m={};
  MANAGERS.forEach(mgr=>{ m[mgr]={calls:0,connected:0,unique_leads:0,tt:0,dur_lt2:0,dur_2_5:0,dur_5_10:0,dur_10p:0,bdas:{}}; });
  rows.forEach(r=>{
    const mgr=r.mgr; if(!mgr||!m[mgr]) return;
    m[mgr].calls+=r.calls; m[mgr].connected+=r.connected;
    m[mgr].unique_leads+=r.unique_leads; m[mgr].tt+=r.tt;
    m[mgr].dur_lt2+=r.dur_lt2; m[mgr].dur_2_5+=r.dur_2_5;
    m[mgr].dur_5_10+=r.dur_5_10; m[mgr].dur_10p+=r.dur_10p;
    if(!m[mgr].bdas[r.bda]) m[mgr].bdas[r.bda]={calls:0,connected:0,unique_leads:0,tt:0,days:0};
    const b=m[mgr].bdas[r.bda];
    b.calls+=r.calls; b.connected+=r.connected; b.unique_leads+=r.unique_leads; b.tt+=r.tt; b.days++;
  });
  return m;
}

function aggLeadsByBDA(rows){
  const out={};
  rows.forEach(r=>{
    const key=r.mgr+'|'+r.bda;
    if(!out[key]) out[key]={mgr:r.mgr,bda:r.bda,stages:{}};
    out[key].stages[r.stage]=(out[key].stages[r.stage]||0)+1;
  });
  return Object.values(out);
}

function aggStages(rows){
  const s={};
  rows.forEach(r=>{ s[r.stage]=(s[r.stage]||0)+1; });
  return s;
}

function dailyAgg(rows, keyFn, valFn){
  const m={};
  rows.forEach(r=>{ const k=keyFn(r); if(!m[k]) m[k]=valFn(); });
  rows.forEach(r=>{ const k=keyFn(r); const v=m[k]; Object.keys(v).forEach(f=>{ if(typeof r[f]==='number') v[f]+=r[f]; }); });
  return m;
}

// ── REVENUE (no date filter — payments are month-level) ──
function revenueMgrRows(rows){
  if(activeTL==='ALL') return rows;
  return rows.filter(r=>r.mgr===activeTL);
}

function revenueScopeLabel(){
  return activeTL==='ALL' ? 'GM Siddhartha · all TLs · May' : activeTL + ' · May';
}

function countByType(rows){
  const m={};
  rows.forEach(r=>{ if(r.type) m[r.type]=(m[r.type]||0)+1; });
  return m;
}

function getRevAgg(){
  const full_rows = revenueMgrRows(RAW.full_rows);
  const tok_rows  = revenueMgrRows(RAW.token_rows);
  const f2 = activeBDA==='ALL' ? full_rows : full_rows.filter(r=>r.bda===activeBDA);
  const t2 = activeBDA==='ALL' ? tok_rows  : tok_rows.filter(r=>r.bda===activeBDA);
  return {
    full_count: f2.length, full_amount: f2.reduce((s,r)=>s+r.amount,0),
    token_count: t2.length, token_amount: t2.reduce((s,r)=>s+r.amount,0),
    full_rows: f2, tok_rows: t2
  };
}

// ── NAV ──────────────────────────────────────────────────
function setView(view, el){
  currentView=view;
  ['revenue','productivity','leads'].forEach(v=>{
    document.getElementById('view-'+v).style.display=v===view?'':'none';
  });
  document.querySelectorAll('.nav-item').forEach(n=>{
    if(n.onclick&&n.onclick.toString().includes("setView('"+view+"'")) n.classList.add('active');
    else if(n.onclick&&n.onclick.toString().includes('setView(')) n.classList.remove('active');
  });
  const titles={revenue:'Revenue Report',productivity:'Productivity',leads:'Lead Report'};
  document.getElementById('page-title').textContent=titles[view];
  const drb=document.getElementById('date-range-bar');
  drb.classList.toggle('visible', view==='productivity'||view==='leads');
  updateBDADropdown();
  render();
}

function filterTL(tl,el){
  activeTL=tl; activeBDA='ALL';
  stageChartMgr=tl;
  document.querySelectorAll('[id^="tl-"]').forEach(n=>n.classList.remove('active'));
  document.getElementById('tl-'+tl).classList.add('active');
  syncStageMgrFilter();
  updateBDADropdown(); render();
}

function filterBDA(val){ activeBDA=val; render(); }

function filterStageMgr(mgr){
  stageChartMgr=mgr;
  syncStageMgrFilter();
  render();
}

function syncStageMgrFilter(){
  const sel=document.getElementById('stage-mgr-filter');
  if(sel) sel.value=stageChartMgr;
}

function stageChartFilterAll(){
  stageChartHidden.clear();
  refreshStageChartFiltersUI();
  applyStageChartVisibility();
}

function toggleStageChartStage(st){
  if(stageChartHidden.has(st)) stageChartHidden.delete(st);
  else if(stageChartHidden.size < stageChartStageKeys.length - 1) stageChartHidden.add(st);
  refreshStageChartFiltersUI();
  applyStageChartVisibility();
}

function refreshStageChartFiltersUI(){
  const allBtn=document.getElementById('stage-filter-all-btn');
  const showAll=stageChartHidden.size===0;
  if(allBtn) allBtn.classList.toggle('active', showAll);
  document.querySelectorAll('.stage-filter-chip').forEach(chip=>{
    const st=chip.dataset.stage;
    if(st) chip.classList.toggle('active', !stageChartHidden.has(st));
  });
  updateStageChartCounters();
}

function updateStageChartCounters(){
  const total=Object.values(stageChartStageTotals).reduce((a,n)=>a+n,0);
  let visible=0;
  stageChartStageKeys.forEach(st=>{
    if(!stageChartHidden.has(st)) visible+=stageChartStageTotals[st]||0;
  });
  const totalEl=document.getElementById('stage-chart-total');
  const visEl=document.getElementById('stage-chart-visible');
  if(totalEl) totalEl.textContent=fmt(total);
  if(visEl) visEl.textContent=fmt(visible);
}

function applyStageChartVisibility(){
  const ch=charts['stageChart'];
  if(!ch) return;
  stageChartStageKeys.forEach((st,i)=>{
    ch.setDatasetVisibility(i, !stageChartHidden.has(st));
  });
  ch.update();
}

function renderStageChartFilterChips(stageKeys){
  const wrap=document.getElementById('stage-chart-chips');
  if(!wrap) return;
  stageChartStageKeys=stageKeys;
  stageChartHidden.forEach(st=>{ if(!stageKeys.includes(st)) stageChartHidden.delete(st); });
  wrap.innerHTML=stageKeys.map((st,i)=>{
    const n=stageChartStageTotals[st]||0;
    const col=leadStageColor(st,i);
    const active=!stageChartHidden.has(st);
    return `<button type="button" class="stage-filter-chip${active?' active':''}" data-stage="${st}">
      <span class="stage-filter-dot" style="background:${col}"></span>
      ${leadStageLabel(st)}<span class="stage-filter-count">${fmt(n)}</span>
    </button>`;
  }).join('');
  wrap.onclick=(e)=>{
    const btn=e.target.closest('.stage-filter-chip');
    if(btn?.dataset.stage) toggleStageChartStage(btn.dataset.stage);
  };
  refreshStageChartFiltersUI();
}

function paymentBdasForScope(){
  const names=new Set();
  revenueMgrRows(RAW.full_rows).forEach(r=>{ const n=(r.bda||'').trim(); if(n) names.add(n); });
  revenueMgrRows(RAW.token_rows).forEach(r=>{ const n=(r.bda||'').trim(); if(n) names.add(n); });
  return [...names].sort();
}

function buildBdaRevenueRows(){
  const bdaMap={};
  revenueMgrRows(RAW.full_rows).forEach(r=>{
    const name=(r.bda||'').trim();
    if(!name) return;
    if(!bdaMap[name]) bdaMap[name]={name,mgr:r.mgr,full_count:0,token_count:0};
    bdaMap[name].full_count++;
  });
  revenueMgrRows(RAW.token_rows).forEach(r=>{
    const name=(r.bda||'').trim();
    if(!name) return;
    if(!bdaMap[name]) bdaMap[name]={name,mgr:r.mgr,full_count:0,token_count:0};
    bdaMap[name].token_count++;
  });
  return Object.values(bdaMap)
    .filter(b=>b.full_count>0||b.token_count>0)
    .sort((a,b)=>(b.full_count+b.token_count)-(a.full_count+a.token_count)||b.full_count-a.full_count);
}

function updateBDADropdown(){
  const sel=document.getElementById('bda-filter');
  sel.innerHTML='<option value="ALL">All BDAs</option>';
  let bdas=[];
  if(currentView==='revenue'){
    bdas=paymentBdasForScope();
  } else if(activeTL!=='ALL'){
    bdas=[...new Set(RAW.input_rows.filter(r=>r.mgr===activeTL).map(r=>r.bda))].sort();
  }
  bdas.forEach(b=>{
    const o=document.createElement('option');
    o.value=b; o.textContent=b;
    sel.appendChild(o);
  });
}

// ── RENDER ────────────────────────────────────────────────
function render(){
  if (!RAW) return;
  if(currentView==='revenue') renderRevenue();
  else if(currentView==='productivity') renderProductivity();
  else renderLeads();
}

const gridC='#f0eeea';
const tick={color:'#7a7870',font:{size:11,family:"'DM Sans',sans-serif"}};
const tooltipOpts={backgroundColor:'#fff',borderColor:'#e8e6df',borderWidth:1,titleColor:'#1a1916',bodyColor:'#7a7870',padding:10,boxPadding:4};

function baseOpts(h=false){
  return {
    responsive:true,maintainAspectRatio:false,
    indexAxis:h?'y':'x',
    plugins:{legend:{display:false},tooltip:tooltipOpts},
    scales:{x:{ticks:tick,grid:{color:gridC}},y:{ticks:tick,grid:{color:gridC}}}
  };
}

// ── REVENUE ───────────────────────────────────────────────
function renderRevenue(){
  const ag=getRevAgg();
  const scope=revenueScopeLabel();
  document.getElementById('r-enr').textContent=fmt(ag.full_count);
  document.getElementById('r-tok').textContent=fmt(ag.token_count);
  document.getElementById('r-enr-sub').textContent=scope;
  document.getElementById('r-tok-sub').textContent=scope;

  const mgrRevCard=document.getElementById('mgr-rev-card');
  if(mgrRevCard) mgrRevCard.style.display=activeTL==='ALL'?'':'none';

  dc('courseChart');
  const fm=countByType(ag.full_rows);
  const tm=countByType(ag.tok_rows);
  const allKeys=[...new Set([...Object.keys(fm),...Object.keys(tm)])];
  const courseSub=document.getElementById('course-chart-sub');
  if(courseSub) courseSub.textContent='Full & token by program · '+scope;
  charts['courseChart']=new Chart(document.getElementById('courseChart'),{
    type:'bar',
    data:{labels:allKeys.map(k=>k.length>32?k.slice(0,32)+'…':k),
      datasets:[
        {label:'Full',data:allKeys.map(k=>fm[k]||0),backgroundColor:'#2563eb',borderRadius:4,barPercentage:.7},
        {label:'Token',data:allKeys.map(k=>tm[k]||0),backgroundColor:'#16a34a',borderRadius:4,barPercentage:.7}
      ]},
    options:{...baseOpts(),plugins:{...baseOpts().plugins,legend:{display:false}}}
  });

  // Revenue by mgr — only when All Managers selected
  if(activeTL==='ALL'){
    const mgrStats={};
    const ensureMgr=m=>{ if(!mgrStats[m]) mgrStats[m]={full_count:0,token_count:0}; };
    MANAGERS.forEach(ensureMgr);
    const bump=(rows,key)=>rows.forEach(r=>{
      const m=MANAGERS.includes(r.mgr)?r.mgr:UNASSIGNED_TL;
      ensureMgr(m);
      mgrStats[m][key]++;
    });
    bump(RAW.full_rows,'full_count');
    bump(RAW.token_rows,'token_count');
    const mgrOrder=[...MANAGERS, ...(mgrStats[UNASSIGNED_TL]&&(mgrStats[UNASSIGNED_TL].full_count||mgrStats[UNASSIGNED_TL].token_count)?[UNASSIGNED_TL]:[])];
    const maxFull=Math.max(...mgrOrder.map(m=>mgrStats[m].full_count),1);
    document.getElementById('mgr-rev-bars').innerHTML=mgrOrder.map(m=>{
      const d=mgrStats[m];
      const w=Math.round(d.full_count/maxFull*100);
      const label=m===UNASSIGNED_TL?'No TL assigned':m;
      return `<div style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
          <span style="font-weight:500">${label}</span>
          <span style="color:var(--muted)">${fmt(d.full_count)} full · ${fmt(d.token_count)} token</span>
        </div>
        <div class="progress-mini"><div class="progress-mini-fill" style="width:${w}%;background:${MGR_COLORS[m]}"></div></div>
      </div>`;
    }).join('');
  }

  // BDA table — only BDAs with ≥1 token or full payment in sheet (current manager scope)
  let bdas=buildBdaRevenueRows();
  if(activeBDA!=='ALL') bdas=bdas.filter(b=>b.name===activeBDA);
  document.getElementById('bda-rev-count').textContent=bdas.length+' BDAs with payments';
  document.getElementById('bda-rev-table').innerHTML=bdas.length?bdas.map(b=>`
    <tr>
      <td><div class="name-cell">${b.name}</div></td>
      <td><span class="pill" style="background:${MGR_COLORS[b.mgr]||'#6b7280'}18;color:${MGR_COLORS[b.mgr]||'#6b7280'}">${b.mgr||'—'}</span></td>
      <td class="num">${b.full_count?fmt(b.full_count):'—'}</td>
      <td class="num">${b.token_count?fmt(b.token_count):'—'}</td>
    </tr>`).join(''):'<tr><td colspan="4" class="empty">No BDAs with token or full payments</td></tr>';
}

// ── PRODUCTIVITY ──────────────────────────────────────────
function renderProductivity(){
  const rows=filteredInputRows();
  const mgrAgg=aggInputsByMgr(rows);

  const totals={calls:0,connected:0,unique_leads:0,tt:0,dur_lt2:0,dur_2_5:0,dur_5_10:0,dur_10p:0};
  const activeBDAs=new Set();
  rows.forEach(r=>{ Object.keys(totals).forEach(k=>{ if(r[k]!==undefined) totals[k]+=r[k]; }); activeBDAs.add(r.bda); });

  document.getElementById('p-calls').textContent=fmt(totals.calls);
  document.getElementById('p-conn').textContent=fmt(totals.connected);
  document.getElementById('p-conn-pct').textContent=pct(totals.connected,totals.calls)+' connect rate';
  document.getElementById('p-leads').textContent=fmt(totals.unique_leads);
  document.getElementById('p-tt').textContent=(totals.tt/60).toFixed(1);
  document.getElementById('p-bdas').textContent=activeBDAs.size;
  document.getElementById('p-calls-sub').textContent='In selected date range';
  document.getElementById('p-chart-sub').textContent='Date range: '+dateFrom.slice(5)+' → '+dateTo.slice(5);

  // Manager grouped bar
  dc('tlCallChart');
  charts['tlCallChart']=new Chart(document.getElementById('tlCallChart'),{
    type:'bar',
    data:{labels:MANAGERS,
      datasets:[
        {label:'Total Calls',data:MANAGERS.map(m=>mgrAgg[m]?.calls||0),backgroundColor:MANAGERS.map(m=>activeTL==='ALL'||activeTL===m?'#2563eb':'#2563eb33'),borderRadius:3,barPercentage:.75},
        {label:'Connected',data:MANAGERS.map(m=>mgrAgg[m]?.connected||0),backgroundColor:MANAGERS.map(m=>activeTL==='ALL'||activeTL===m?'#16a34a':'#16a34a33'),borderRadius:3,barPercentage:.75},
        {label:'Unique Leads',data:MANAGERS.map(m=>mgrAgg[m]?.unique_leads||0),backgroundColor:MANAGERS.map(m=>activeTL==='ALL'||activeTL===m?'#d97706':'#d9770633'),borderRadius:3,barPercentage:.75}
      ]},
    options:{...baseOpts(),plugins:{...baseOpts().plugins}}
  });

  // Connect rate bars
  document.getElementById('conn-rate-bars').innerHTML=MANAGERS.map(m=>{
    const d=mgrAgg[m]||{calls:0,connected:0};
    const rate=d.calls?d.connected/d.calls*100:0;
    const active=activeTL==='ALL'||activeTL===m;
    return `<div style="margin-bottom:12px;opacity:${active?1:.3}">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
        <span style="font-weight:500">${m}</span>
        <span style="color:${MGR_COLORS[m]};font-weight:600">${rate.toFixed(1)}%</span>
      </div>
      <div class="progress-mini"><div class="progress-mini-fill" style="width:${Math.min(rate,100).toFixed(1)}%;background:${MGR_COLORS[m]}"></div></div>
      <div style="font-size:11px;color:var(--muted);margin-top:2px">${fmt(d.connected)} / ${fmt(d.calls)} calls</div>
    </div>`;
  }).join('');

  // Daily calls chart — only dates in range
  dc('dailyCallChart');
  const allDates=Object.keys(RAW.daily_calls).filter(d=>inRange(d));
  // Recompute daily from filtered rows
  const dailyCallMap={};
  rows.forEach(r=>{ if(!dailyCallMap[r.date]) dailyCallMap[r.date]={calls:0,connected:0}; dailyCallMap[r.date].calls+=r.calls; dailyCallMap[r.date].connected+=r.connected; });
  const dKeys=Object.keys(dailyCallMap).sort();
  document.getElementById('daily-call-sub').textContent='Calls & connections per day ('+dateFrom.slice(5)+' → '+dateTo.slice(5)+')';
  const dailyTotalCalls=dKeys.reduce((s,d)=>s+dailyCallMap[d].calls,0);
  const dailyTotalConn=dKeys.reduce((s,d)=>s+dailyCallMap[d].connected,0);
  const dailyCallsEl=document.getElementById('daily-total-calls');
  const dailyConnEl=document.getElementById('daily-total-conn');
  if(dailyCallsEl) dailyCallsEl.textContent=fmt(dailyTotalCalls);
  if(dailyConnEl) dailyConnEl.textContent=fmt(dailyTotalConn);

  const manyDays=dKeys.length>14;
  charts['dailyCallChart']=new Chart(document.getElementById('dailyCallChart'),{
    type:'bar',
    data:{labels:dKeys.map(d=>d.slice(5)),
      datasets:[
        {label:'Total Calls',data:dKeys.map(d=>dailyCallMap[d].calls),backgroundColor:'#2563eb',borderRadius:3,barPercentage:manyDays?0.9:0.75,categoryPercentage:manyDays?0.85:0.7},
        {label:'Connected',data:dKeys.map(d=>dailyCallMap[d].connected),backgroundColor:'#16a34a',borderRadius:3,barPercentage:manyDays?0.9:0.75,categoryPercentage:manyDays?0.85:0.7}
      ]},
    options:{
      responsive:true,maintainAspectRatio:false,
      layout:{padding:{top:8,right:12,bottom:4,left:4}},
      plugins:{
        legend:{display:true,position:'top',align:'end',labels:{font:{size:11},boxWidth:12,padding:12}},
        tooltip:tooltipOpts
      },
      scales:{
        x:{
          ticks:{...tick,maxRotation:manyDays?45:0,autoSkip:manyDays,minRotation:0},
          grid:{display:false}
        },
        y:{
          ticks:tick,
          grid:{color:gridC},
          beginAtZero:true
        }
      }
    }
  });

  // Duration doughnut from filtered rows
  dc('durChart');
  charts['durChart']=new Chart(document.getElementById('durChart'),{
    type:'doughnut',
    data:{labels:['< 2 min','2–5 min','5–10 min','10+ min'],
      datasets:[{data:[totals.dur_lt2,totals.dur_2_5,totals.dur_5_10,totals.dur_10p],
        backgroundColor:['#dc2626','#d97706','#2563eb','#16a34a'],borderWidth:0,hoverOffset:4}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:'60%',
      plugins:{legend:{position:'right',labels:{font:{size:11},padding:10,boxWidth:10}},tooltip:tooltipOpts}}
  });

  // BDA table — aggregate from filtered rows per bda
  const bdaMap={};
  rows.forEach(r=>{
    const k=r.bda;
    if(!bdaMap[k]) bdaMap[k]={mgr:r.mgr,calls:0,connected:0,unique_leads:0,tt:0,days:0};
    bdaMap[k].calls+=r.calls; bdaMap[k].connected+=r.connected;
    bdaMap[k].unique_leads+=r.unique_leads; bdaMap[k].tt+=r.tt; bdaMap[k].days++;
  });
  const bdas=Object.entries(bdaMap).map(([name,d])=>({name,...d})).sort((a,b)=>b.calls-a.calls);
  document.getElementById('bda-prod-count').textContent=bdas.length+' BDAs · '+dateFrom.slice(5)+' → '+dateTo.slice(5);
  document.getElementById('bda-prod-table').innerHTML=bdas.map(b=>{
    const rate=b.calls?(b.connected/b.calls*100).toFixed(1):0;
    const cls=rate>=30?'pill-green':rate>=20?'pill-blue':'pill-amber';
    const cpl=b.unique_leads?(b.calls/b.unique_leads).toFixed(1):'—';
    return `<tr>
      <td><div class="name-cell">${b.name}</div></td>
      <td><span class="pill" style="background:${MGR_COLORS[b.mgr]||'#6b7280'}18;color:${MGR_COLORS[b.mgr]||'#6b7280'}">${b.mgr}</span></td>
      <td class="num">${fmt(b.calls)}</td>
      <td class="num">${fmt(b.connected)}</td>
      <td class="num"><span class="pill ${cls}">${rate}%</span></td>
      <td class="num">${fmt(b.unique_leads)}</td>
      <td class="num">${cpl}</td>
      <td class="num">${Math.round(b.tt)}</td>
      <td class="num">${b.days}</td>
    </tr>`;
  }).join('');
}

// ── LEADS (Final Stage + Subsource) ───────────────────────
const LEAD_STAGE_ORDER=[
  'Interested','Interested-Test','Follow_Up','Call_Back_Later','Token_Paid','Learner_Enrolled','Fresh_Lead','New_Enquiry',
  'Full_Payment_Done','Offer_Letter',
  'Not_Connected','Not_Interested','Not_Eligible','Invalid'
];
const LEAD_STAGE_META={
  Interested:{color:'#db2777',label:'Interested'},
  'Interested-Test':{color:'#c026d3',label:'Interested (Test)'},
  Follow_Up:{color:'#0d9488',label:'Follow-up'},
  Call_Back_Later:{color:'#7c3aed',label:'Call Back Later'},
  Token_Paid:{color:'#d97706',label:'Token Paid'},
  Learner_Enrolled:{color:'#16a34a',label:'Learner Enrolled'},
  Fresh_Lead:{color:'#2563eb',label:'Fresh Lead'},
  New_Enquiry:{color:'#2563eb',label:'New Enquiry'},
  Full_Payment_Done:{color:'#059669',label:'Full Payment Done'},
  Offer_Letter:{color:'#0891b2',label:'Offer Letter'},
  Not_Connected:{color:'#f59e0b',label:'Not Connected'},
  Not_Interested:{color:'#ef4444',label:'Not Interested'},
  Not_Eligible:{color:'#6b7280',label:'Not Eligible'},
  Invalid:{color:'#9ca3af',label:'Invalid'},
};
const STAGE_CHART_FALLBACK=['#2563eb','#0d9488','#d97706','#7c3aed','#db2777','#16a34a','#ef4444','#6b7280'];

function leadStageLabel(key){
  return (LEAD_STAGE_META[key]||{}).label||key.replace(/_/g,' ');
}
function leadStageColor(key, idx){
  return (LEAD_STAGE_META[key]||{}).color||STAGE_CHART_FALLBACK[idx%STAGE_CHART_FALLBACK.length];
}
function leadStagesInData(rows){
  const present=new Set();
  rows.forEach(r=>{ if(r.stage) present.add(r.stage); });
  const ordered=LEAD_STAGE_ORDER.filter(k=>present.has(k));
  [...present].filter(k=>!LEAD_STAGE_ORDER.includes(k)).sort().forEach(k=>ordered.push(k));
  return ordered;
}

function renderLeads(){
  const rows=filteredLeadRows();
  const stages=aggStages(rows);
  const total=rows.length;

  document.getElementById('l-total').textContent=fmt(total);
  document.getElementById('l-warm').textContent=fmt(stages['Interested']||0);
  document.getElementById('l-fup').textContent=fmt((stages['Follow_Up']||0)+(stages['Call_Back_Later']||0));
  document.getElementById('l-nc').textContent=fmt(stages['Not_Connected']||0);
  document.getElementById('l-inv').textContent=fmt((stages['Invalid']||0)+(stages['Not_Interested']||0)+(stages['Not_Eligible']||0));

  const sub=activeBDA!=='ALL'?activeBDA:activeTL!=='ALL'?activeTL+"'s team":'All managers';
  document.getElementById('funnel-subtitle').textContent=sub+' · '+dateFrom.slice(5)+' → '+dateTo.slice(5)+' · '+fmt(total)+' leads';
  document.getElementById('daily-lead-sub').textContent='New leads · '+dateFrom.slice(5)+' → '+dateTo.slice(5);

  // Funnel — buckets from Final Stage column only
  const stageCols=leadStagesInData(rows);
  const funnelDef=stageCols
    .filter(k=>(stages[k]||0)>0)
    .map((k,i)=>({key:k,color:leadStageColor(k,i),label:leadStageLabel(k)}));
  const maxCnt=Math.max(...funnelDef.map(s=>stages[s.key]||0),1);
  document.getElementById('lead-funnel').innerHTML=funnelDef.length?funnelDef.map(s=>{
    const cnt=stages[s.key]||0;
    const w=Math.round(cnt/maxCnt*100);
    const p=total?(cnt/total*100).toFixed(1):'0.0';
    return `<div class="funnel-row">
      <div class="funnel-stage">${s.label}</div>
      <div class="funnel-bar-wrap"><div class="funnel-bar" style="width:${Math.max(w,1)}%;background:${s.color}">${cnt>30?`<span>${fmt(cnt)}</span>`:''}</div></div>
      <div class="funnel-count">${fmt(cnt)}</div>
      <div class="funnel-pct">${p}%</div>
    </div>`;
  }).join(''):'<div class="empty">No leads in selected range</div>';

  // Daily lead chart — from filtered rows
  dc('dailyLeadChart');
  const dlMap={};
  rows.forEach(r=>{ dlMap[r.date]=(dlMap[r.date]||0)+1; });
  const dlKeys=Object.keys(dlMap).sort();
  const leadPeriodTotal=dlKeys.reduce((s,d)=>s+dlMap[d],0);
  const leadAvg=dlKeys.length?Math.round(leadPeriodTotal/dlKeys.length):0;
  const leadTotalEl=document.getElementById('daily-lead-total');
  const leadAvgEl=document.getElementById('daily-lead-avg');
  if(leadTotalEl) leadTotalEl.textContent=fmt(leadPeriodTotal);
  if(leadAvgEl) leadAvgEl.textContent=fmt(leadAvg);

  const manyLeadDays=dlKeys.length>14;
  charts['dailyLeadChart']=new Chart(document.getElementById('dailyLeadChart'),{
    type:'line',
    data:{labels:dlKeys.map(d=>d.slice(5)),
      datasets:[{
        label:'New Leads',
        data:dlKeys.map(d=>dlMap[d]),
        borderColor:'#2563eb',
        backgroundColor:'#2563eb22',
        fill:true,
        tension:.35,
        borderWidth:2.5,
        pointRadius:manyLeadDays?3:4,
        pointHoverRadius:6
      }]},
    options:{
      responsive:true,
      maintainAspectRatio:false,
      layout:{padding:{top:12,right:16,bottom:8,left:8}},
      interaction:{mode:'nearest',axis:'x',intersect:false},
      hover:{mode:'nearest',axis:'x',intersect:false},
      plugins:{legend:{display:false},tooltip:tooltipOpts},
      elements:{point:{hitRadius:16,hoverRadius:6}},
      scales:{
        x:{
          ticks:{...tick,maxRotation:manyLeadDays?45:0,autoSkip:manyLeadDays,minRotation:0},
          grid:{display:false}
        },
        y:{
          ticks:tick,
          grid:{color:gridC},
          beginAtZero:true
        }
      }
    }
  });

  // Source pie — from filtered rows
  dc('sourceChart');
  const srcMap={};
  rows.forEach(r=>{ srcMap[r.source]=(srcMap[r.source]||0)+1; });
  delete srcMap[''];
  const srcEntries=Object.entries(srcMap).sort((a,b)=>b[1]-a[1]).slice(0,8);
  charts['sourceChart']=new Chart(document.getElementById('sourceChart'),{
    type:'doughnut',
    data:{labels:srcEntries.map(e=>e[0]),datasets:[{data:srcEntries.map(e=>e[1]),
      backgroundColor:['#2563eb','#0d9488','#d97706','#7c3aed','#db2777','#16a34a','#ef4444','#6b7280'],borderWidth:0,hoverOffset:4}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:'55%',
      plugins:{legend:{position:'right',labels:{font:{size:10},padding:8,boxWidth:8}},tooltip:tooltipOpts}}
  });

  // Manager stacked stage bar — chart-local manager filter (incl. All)
  dc('stageChart');
  const stageRows=filteredLeadRowsForStageChart();
  const chartMgrs=stageChartMgr==='ALL'?MANAGERS:[stageChartMgr];
  const stageSub=document.getElementById('stage-chart-sub');
  if(stageSub){
    stageSub.textContent=stageChartMgr==='ALL'
      ?'Stacked by Final Stage · all managers · '+dateFrom.slice(5)+' → '+dateTo.slice(5)
      :'Stacked by Final Stage · '+stageChartMgr+' · '+dateFrom.slice(5)+' → '+dateTo.slice(5);
  }
  syncStageMgrFilter();
  const mgrStageMap={};
  chartMgrs.forEach(m=>{ mgrStageMap[m]={}; });
  stageRows.forEach(r=>{
    if(!mgrStageMap[r.mgr]) return;
    mgrStageMap[r.mgr][r.stage]=(mgrStageMap[r.mgr][r.stage]||0)+1;
  });
  const stageColsChart=leadStagesInData(stageRows);
  stageChartStageTotals={};
  stageRows.forEach(r=>{ stageChartStageTotals[r.stage]=(stageChartStageTotals[r.stage]||0)+1; });
  renderStageChartFilterChips(stageColsChart);
  charts['stageChart']=new Chart(document.getElementById('stageChart'),{
    type:'bar',
    data:{
      labels:chartMgrs,
      datasets:stageColsChart.map((st,i)=>({
        label:leadStageLabel(st),
        data:chartMgrs.map(m=>mgrStageMap[m][st]||0),
        backgroundColor:leadStageColor(st,i),
        stack:'s',
      })),
    },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      layout:{padding:{top:8,right:12,bottom:4,left:4}},
      plugins:{
        legend:{display:false},
        tooltip:tooltipOpts,
      },
      scales:{
        x:{stacked:true,ticks:{...tick,font:{size:12}},grid:{display:false}},
        y:{stacked:true,ticks:tick,grid:{color:gridC}},
      },
    },
  });
  applyStageChartVisibility();

  // BDA lead table — columns per Final Stage
  const bdaLeads=aggLeadsByBDA(rows).sort((a,b)=>{
    const ta=Object.values(a.stages).reduce((x,y)=>x+y,0);
    const tb=Object.values(b.stages).reduce((x,y)=>x+y,0);
    return tb-ta;
  });
  document.getElementById('bda-lead-count').textContent=bdaLeads.length+' BDAs · Final Stage · '+dateFrom.slice(5)+' → '+dateTo.slice(5);
  const thead=document.getElementById('bda-lead-thead');
  if(thead){
    thead.innerHTML='<tr><th class="col-freeze col-freeze-1">BDA</th><th class="col-freeze col-freeze-2">Manager</th><th class="col-freeze col-freeze-3 num">Total</th>'
      +stageCols.map(st=>`<th class="num">${leadStageLabel(st)}</th>`).join('')
      +'</tr>';
  }
  document.getElementById('bda-lead-table').innerHTML=bdaLeads.map(b=>{
    const s=b.stages||{};
    const tot=Object.values(s).reduce((a,x)=>a+x,0);
    const stageCells=stageCols.map(st=>{
      const n=s[st]||0;
      return `<td class="num">${n?fmt(n):'—'}</td>`;
    }).join('');
    return `<tr>
      <td class="col-freeze col-freeze-1"><div class="name-cell">${b.bda}</div></td>
      <td class="col-freeze col-freeze-2"><span class="pill" style="background:${MGR_COLORS[b.mgr]||'#6b7280'}18;color:${MGR_COLORS[b.mgr]||'#6b7280'}">${b.mgr}</span></td>
      <td class="col-freeze col-freeze-3 num"><strong>${fmt(tot)}</strong></td>
      ${stageCells}
    </tr>`;
  }).join('');
}

// ── INIT ─────────────────────────────────────────────────
loadDashboardData();
setInterval(() => loadDashboardData(true), API_REFRESH_MS);
