"""Configuration for the live dashboard proxy server."""

import os

# ── Server ────────────────────────────────────────────────────────────────────
DEBUG = os.getenv("DEBUG", "true").lower() in {"1", "true", "yes"}
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "5000"))
REFRESH_INTERVAL_MINUTES = int(os.getenv("REFRESH_INTERVAL_MINUTES", "5"))
REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "30"))

# ── Filters ───────────────────────────────────────────────────────────────────
GM_NAME = os.getenv("GM_NAME", "Siddhartha")
PAYMENT_MONTH = int(os.getenv("PAYMENT_MONTH", "5"))  # May
DEFAULT_TOKEN_AMOUNT = float(os.getenv("DEFAULT_TOKEN_AMOUNT", "5000"))

# Sheet columns: GM = general manager filter; TL = team lead (manager) on payments
GM_COLUMNS = ("GM Name", "GM")
TL_COLUMNS = ("TL NAME", "TL Name", "TL")
# Payments under Siddhartha GM with no TL still count toward KPI totals
UNASSIGNED_TL = os.getenv("UNASSIGNED_TL", "Unassigned")

# Default month window (May 2026) — UI date range is derived from live sheet data when available
MONTH_START = os.getenv("MONTH_START", "2026-05-01")
MONTH_END = os.getenv("MONTH_END", "2026-05-31")
# Lead dump backend filter (optional cap; UI can show full input date range)
LEAD_DATE_START = os.getenv("LEAD_DATE_START", MONTH_START)
LEAD_DATE_END = os.getenv("LEAD_DATE_END", MONTH_END)

# ── Google Sheets CSV URLs ────────────────────────────────────────────────────
CSV_URLS = {
    "leads": os.getenv(
        "LEADS_CSV_URL",
        "https://docs.google.com/spreadsheets/d/e/2PACX-1vS6sKBGja2Ugu8eLACnO7mbztHeHGR9Xig_CE_FsnjETYVbeKO2nXi9uRXp54Tioyc4E96xDtJe780Y/pub?gid=0&single=true&output=csv",
    ),
    "inputs": os.getenv(
        "INPUTS_CSV_URL",
        "https://docs.google.com/spreadsheets/d/e/2PACX-1vT6_Ukl-_qTeyobt1Q3SpgXhR0921qgUWrz6WPnINvl3U2OXl1dcsjEyGgMafUmG_cb9rE6QNrWZkuX/pub?gid=948739317&single=true&output=csv",
    ),
    "tokens": os.getenv(
        "TOKENS_CSV_URL",
        "https://docs.google.com/spreadsheets/d/e/2PACX-1vTcztb-A37i4VXvWKnATdaFrGPZGf5tQlsYIDgdb7CViBh_TpL0kdst-OVwlEBxISLK1fHob_G86ffr/pub?gid=0&single=true&output=csv",
    ),
    "fullpayments": os.getenv(
        "FULLPAYMENTS_CSV_URL",
        "https://docs.google.com/spreadsheets/d/e/2PACX-1vTcztb-A37i4VXvWKnATdaFrGPZGf5tQlsYIDgdb7CViBh_TpL0kdst-OVwlEBxISLK1fHob_G86ffr/pub?gid=703953175&single=true&output=csv",
    ),
}

MANAGERS = ["Adnan", "Sudhanshu", "Shailendra", "Bhavya"]
