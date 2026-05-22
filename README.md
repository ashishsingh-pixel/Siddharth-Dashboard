# GM Live Analytics Dashboard

Live Google Sheets → dashboard UI (Revenue, Productivity, Lead Report).

## Project layout

```text
Dashboard/
├── templates/index.html   # Main UI
├── static/app.js          # Charts, filters, API client
├── static/styles.css
├── build.mjs              # Netlify: copies UI → public/
├── netlify/
│   └── functions/         # Serverless API (sheet fetch + filter)
├── netlify.toml
├── package.json           # papaparse for functions only
├── .env.example           # Copy to Netlify env vars
│
├── server.py              # Optional: local Flask (same API paths)
├── config.py
├── data_processor.py
└── requirements.txt
```

## Run locally (Flask)

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python server.py
```

Open http://localhost:5000

## Deploy on Netlify

1. Push repo to GitHub (see `.gitignore` — no `node_modules`, `.env`, or `public/`).
2. New site → import repo.
3. Build: `npm install && npm run build` · Publish: `public`
4. Add all variables from `.env.example` under **Site configuration → Environment variables**.
5. Deploy. Test: `https://YOUR-SITE.netlify.app/api/health`

Local Netlify preview:

```bash
copy .env.example .env
npm install && npm run build
npx netlify dev
```

## API (UI uses these)

- `GET /api/dashboard` — full dataset for charts/tables
- `GET /api/kpis` — summary metrics
- `GET /api/health` — status

## Monthly updates

Change in Netlify env (then redeploy): `PAYMENT_MONTH`, optional `MONTH_START` / `MONTH_END`.  
Leads/productivity date range follows live sheet data automatically.
