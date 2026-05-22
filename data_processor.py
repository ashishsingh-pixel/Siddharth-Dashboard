"""Fetch, clean, filter, and aggregate Google Sheets CSV data for the dashboard."""

from __future__ import annotations

import io
import logging
from datetime import datetime
from typing import Any

import pandas as pd
import requests

import config

logger = logging.getLogger(__name__)


def _response(success: bool, data: Any, updated_at: str | None = None, error: str | None = None) -> dict:
    payload: dict[str, Any] = {
        "success": success,
        "updated_at": updated_at or datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "data": data,
    }
    if error:
        payload["error"] = error
    return payload


def _clean_str(value: Any) -> str | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    text = str(value).strip()
    return text or None


def _email_to_name(email: Any) -> str | None:
    email = _clean_str(email)
    if not email or "@" not in email:
        return None
    local = email.split("@", 1)[0]
    parts = local.replace(".", " ").replace("_", " ").split()
    return " ".join(part.capitalize() for part in parts) if parts else None


def _to_float(value: Any, default: float = 0.0) -> float:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return default
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return default


def _to_int(value: Any, default: int = 0) -> int:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _parse_date(value: Any) -> str | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    text = str(value).strip()
    if not text:
        return None
    dayfirst = not text[:4].isdigit()
    parsed = pd.to_datetime(value, errors="coerce", dayfirst=dayfirst)
    if pd.isna(parsed):
        return None
    return parsed.strftime("%Y-%m-%d")


def _drop_blank_rows(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    return df.dropna(how="all").copy()


def _column_present(df: pd.DataFrame, candidates: tuple[str, ...]) -> str | None:
    for col in candidates:
        if col in df.columns:
            return col
    return None


def _filter_gm(df: pd.DataFrame) -> pd.DataFrame:
    """Keep rows where GM column equals Siddhartha (all managers' payments under this GM)."""
    gm_col = _column_present(df, config.GM_COLUMNS)
    if not gm_col:
        return df.iloc[0:0].copy()
    gm = df[gm_col].astype(str).str.strip()
    return df[gm == config.GM_NAME].copy()


def _filter_lead_dates(df: pd.DataFrame) -> pd.DataFrame:
    """Keep leads within the dashboard month window (May 1–20)."""
    if df.empty or "Created On" not in df.columns:
        return df.iloc[0:0].copy()
    dates = pd.to_datetime(df["Created On"], errors="coerce")
    mask = (dates >= config.LEAD_DATE_START) & (dates <= config.LEAD_DATE_END)
    return df[mask].copy()


def _normalize_final_stage(value: Any) -> str | None:
    text = _clean_str(value)
    if not text:
        return None
    # Final Stage uses underscores (e.g. Not_Connected, Interested-Test)
    return text.replace(" ", "_")


# CRM Stage column maps to dashboard buckets (matches original embedded dashboard logic)
_STAGE_TO_BUCKET: dict[str, str] = {
    "Warm": "Warm",
    "Follow Up": "Follow_Up",
    "Call Back Later": "Call_Back_Later",
    "Not Interested": "Not_Interested",
    "Not Eligible": "Not_Eligible",
    "Invalid": "Invalid",
    "Interested": "Interested",
    "Token Paid": "Token_Paid",
    "Did Not Picked": "Not_Connected",
    "Never Picked Up": "Not_Connected",
    "Did Not Enquired": "Not_Connected",
    "Call Not Connected": "Not_Connected",
    "Wrong Number": "Invalid",
    "Future Prospect": "Follow_Up",
    "Test Sent": "Follow_Up",
    "New Enquiry": "New_Enquiry",
    "Learner Enrolled": "Learner_Enrolled",
}


def resolve_lead_stage(record: Any) -> str | None:
    """Lead funnel and stage KPIs use Final Stage column only."""
    return _normalize_final_stage(record.get("Final Stage"))


def _filter_payment_month(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    month_col = "Month.1" if "Month.1" in df.columns else "Month"
    if month_col not in df.columns:
        return df.iloc[0:0].copy()
    month_values = pd.to_numeric(df[month_col], errors="coerce")
    return df[month_values == config.PAYMENT_MONTH].copy()


def fetch_csv(name: str, url: str) -> pd.DataFrame:
    """Download a published Google Sheet CSV into a cleaned DataFrame."""
    logger.info("Fetching CSV: %s", name)
    response = requests.get(url, timeout=config.REQUEST_TIMEOUT)
    response.raise_for_status()
    df = pd.read_csv(io.StringIO(response.text), low_memory=False)
    df = _drop_blank_rows(df)
    logger.info("Loaded %s rows for %s", len(df), name)
    return df


def build_bda_manager_map(lead_df: pd.DataFrame) -> dict[str, str]:
    """Map BDA names to manager names using lead ownership data."""
    if lead_df.empty:
        return {}

    subset = lead_df.dropna(subset=["Owner (User Name)", "Manager Name"]).copy()
    if subset.empty:
        return {}

    grouped = (
        subset.groupby("Owner (User Name)")["Manager Name"]
        .agg(lambda values: values.mode().iloc[0] if not values.mode().empty else values.iloc[0])
    )
    return {str(k).strip(): str(v).strip() for k, v in grouped.items() if _clean_str(k) and _clean_str(v)}


def process_leads(df: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for _, record in df.iterrows():
        date = _parse_date(record.get("Created On"))
        mgr = _clean_str(record.get("Manager Name"))
        bda = _clean_str(record.get("Owner (User Name)"))
        stage = resolve_lead_stage(record)
        source = _clean_str(record.get("Subsource")) or ""

        if not date or not mgr or not bda or not stage:
            continue

        rows.append(
            {
                "date": date,
                "mgr": mgr,
                "bda": bda,
                "stage": stage,
                "source": source,
            }
        )
    return rows


def process_inputs(df: pd.DataFrame, bda_mgr: dict[str, str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for _, record in df.iterrows():
        date = _parse_date(record.get("Date"))
        bda = _email_to_name(record.get("Owner Name"))
        mgr = _clean_str(record.get("Manager Name")) or (bda_mgr.get(bda) if bda else None)

        if not date or not bda or not mgr:
            continue

        rows.append(
            {
                "date": date,
                "mgr": mgr,
                "bda": bda,
                "calls": _to_int(record.get("# Calls")),
                "connected": _to_int(record.get("# Calls Connected")),
                "unique_leads": _to_int(record.get("# Unique Leads")),
                "tt": round(_to_float(record.get("Total Call Duration")), 2),
                "outbound": _to_int(record.get("# Outbound Calls")),
                "inbound": _to_int(record.get("# Inbound Calls")),
                "outbound_ans": _to_int(record.get("# Outbound Answered Calls")),
                "inbound_ans": _to_int(record.get("# Inbound Answered Calls")),
                "dur_lt2": _to_int(record.get("# Call Duration <2mins")),
                "dur_2_5": _to_int(record.get("# Call Duration >=2mins & <5mins")),
                "dur_5_10": _to_int(record.get("# Call Duration >=5mins & <10mins")),
                "dur_10p": _to_int(record.get("# Call Duration >=10mins")),
            }
        )
    return rows


def _resolve_tl(record: Any) -> str:
    """
    Team lead (manager) from TL column only.

    Do not infer from lead dump / Agent — future rows may have GM=Siddhartha
    with an empty TL; those still count in KPI totals as Unassigned.
    """
    for col in config.TL_COLUMNS:
        tl = _clean_str(record.get(col))
        if tl in config.MANAGERS:
            return tl
    return config.UNASSIGNED_TL


def process_tokens(df: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for _, record in df.iterrows():
        bda = _clean_str(record.get("Agent"))
        course = _clean_str(record.get("Type"))
        if not bda or not course:
            continue

        mgr = _resolve_tl(record)
        amount = _to_float(record.get("Token Amount"), default=config.DEFAULT_TOKEN_AMOUNT)
        if pd.isna(record.get("Token Amount")) or _clean_str(record.get("Token Amount")) is None:
            amount = config.DEFAULT_TOKEN_AMOUNT

        rows.append(
            {
                "mgr": mgr,
                "bda": bda,
                "amount": amount,
                "type": course,
            }
        )
    return rows


def process_full_payments(df: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for _, record in df.iterrows():
        bda = _clean_str(record.get("Agent"))
        course = _clean_str(record.get("Type"))
        amount = _to_float(record.get("Amount Paid"))
        if not bda or not course or amount <= 0:
            continue

        mgr = _resolve_tl(record)
        rows.append(
            {
                "mgr": mgr,
                "bda": bda,
                "amount": amount,
                "type": course,
            }
        )
    return rows


def count_by_key(rows: list[dict[str, Any]], key: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        value = row.get(key)
        if not value:
            continue
        counts[value] = counts.get(value, 0) + 1
    return counts


def aggregate_stages(lead_rows: list[dict[str, Any]]) -> dict[str, int]:
    return count_by_key(lead_rows, "stage")


def build_daily_calls(input_rows: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    daily: dict[str, dict[str, int]] = {}
    for row in input_rows:
        date = row["date"]
        if date not in daily:
            daily[date] = {"calls": 0, "connected": 0}
        daily[date]["calls"] += row.get("calls", 0)
        daily[date]["connected"] += row.get("connected", 0)
    return daily


def compute_kpis(
    lead_rows: list[dict[str, Any]],
    input_rows: list[dict[str, Any]],
    token_rows: list[dict[str, Any]],
    full_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    total_leads = len(lead_rows)
    total_inputs = len(input_rows)
    total_tokens = len(token_rows)
    total_full = len(full_rows)
    token_revenue = round(sum(row.get("amount", 0) for row in token_rows), 2)
    full_revenue = round(sum(row.get("amount", 0) for row in full_rows), 2)
    total_revenue = round(token_revenue + full_revenue, 2)

    lead_to_token = round((total_tokens / total_leads * 100), 2) if total_leads else 0.0
    token_to_full = round((total_full / total_tokens * 100), 2) if total_tokens else 0.0
    overall = round((total_full / total_leads * 100), 2) if total_leads else 0.0

    return {
        "total_leads": total_leads,
        "total_inputs": total_inputs,
        "total_token_payments": total_tokens,
        "total_full_payments": total_full,
        "token_revenue": token_revenue,
        "full_revenue": full_revenue,
        "total_revenue": total_revenue,
        "lead_to_token_conversion_pct": lead_to_token,
        "token_to_full_conversion_pct": token_to_full,
        "overall_conversion_pct": overall,
        "avg_deal_size": round(full_revenue / total_full, 2) if total_full else 0.0,
    }


def build_funnel(lead_rows: list[dict[str, Any]]) -> dict[str, Any]:
    stages = aggregate_stages(lead_rows)
    total = len(lead_rows)
    ordered = [
        "Interested",
        "Follow_Up",
        "Call_Back_Later",
        "Token_Paid",
        "Learner_Enrolled",
        "Fresh_Lead",
        "New_Enquiry",
        "Not_Connected",
        "Not_Interested",
        "Not_Eligible",
        "Invalid",
    ]
    funnel = []
    for stage in ordered:
        count = stages.get(stage, 0)
        funnel.append(
            {
                "stage": stage,
                "count": count,
                "pct": round((count / total * 100), 2) if total else 0.0,
            }
        )
    return {"total_leads": total, "stages": funnel, "stage_counts": stages}


def build_revenue(token_rows: list[dict[str, Any]], full_rows: list[dict[str, Any]]) -> dict[str, Any]:
    token_revenue = round(sum(row.get("amount", 0) for row in token_rows), 2)
    full_revenue = round(sum(row.get("amount", 0) for row in full_rows), 2)
    return {
        "token_count": len(token_rows),
        "full_count": len(full_rows),
        "token_revenue": token_revenue,
        "full_revenue": full_revenue,
        "total_revenue": round(token_revenue + full_revenue, 2),
        "full_by_course": count_by_key(full_rows, "type"),
        "token_by_course": count_by_key(token_rows, "type"),
        "by_manager": {
            mgr: {
                "full_count": sum(1 for row in full_rows if row.get("mgr") == mgr),
                "full_revenue": round(sum(row.get("amount", 0) for row in full_rows if row.get("mgr") == mgr), 2),
                "token_count": sum(1 for row in token_rows if row.get("mgr") == mgr),
                "token_revenue": round(sum(row.get("amount", 0) for row in token_rows if row.get("mgr") == mgr), 2),
            }
            for mgr in config.MANAGERS
        },
    }


def build_charts(
    lead_rows: list[dict[str, Any]],
    input_rows: list[dict[str, Any]],
    token_rows: list[dict[str, Any]],
    full_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "leads_by_source": count_by_key(lead_rows, "source"),
        "full_by_course": count_by_key(full_rows, "type"),
        "token_by_course": count_by_key(token_rows, "type"),
        "daily_calls": build_daily_calls(input_rows),
        "daily_leads": count_by_key(lead_rows, "date"),
        "stage_by_manager": {
            mgr: aggregate_stages([row for row in lead_rows if row.get("mgr") == mgr])
            for mgr in config.MANAGERS
        },
    }


def build_tables(
    lead_rows: list[dict[str, Any]],
    input_rows: list[dict[str, Any]],
    token_rows: list[dict[str, Any]],
    full_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    bda_revenue: dict[str, dict[str, Any]] = {}

    for row in full_rows:
        name = row["bda"]
        if name not in bda_revenue:
            bda_revenue[name] = {
                "bda": name,
                "mgr": row.get("mgr", ""),
                "full_count": 0,
                "full_amount": 0.0,
                "token_count": 0,
                "token_amount": 0.0,
            }
        bda_revenue[name]["full_count"] += 1
        bda_revenue[name]["full_amount"] += row.get("amount", 0)

    for row in token_rows:
        name = row["bda"]
        if name not in bda_revenue:
            bda_revenue[name] = {
                "bda": name,
                "mgr": row.get("mgr", ""),
                "full_count": 0,
                "full_amount": 0.0,
                "token_count": 0,
                "token_amount": 0.0,
            }
        bda_revenue[name]["token_count"] += 1
        bda_revenue[name]["token_amount"] += row.get("amount", 0)

    bda_productivity: dict[str, dict[str, Any]] = {}
    for row in input_rows:
        name = row["bda"]
        if name not in bda_productivity:
            bda_productivity[name] = {
                "bda": name,
                "mgr": row.get("mgr", ""),
                "calls": 0,
                "connected": 0,
                "unique_leads": 0,
                "tt": 0.0,
                "days": set(),
            }
        entry = bda_productivity[name]
        entry["calls"] += row.get("calls", 0)
        entry["connected"] += row.get("connected", 0)
        entry["unique_leads"] += row.get("unique_leads", 0)
        entry["tt"] += row.get("tt", 0)
        entry["days"].add(row.get("date"))

    productivity_rows = []
    for entry in bda_productivity.values():
        productivity_rows.append(
            {
                "bda": entry["bda"],
                "mgr": entry["mgr"],
                "calls": entry["calls"],
                "connected": entry["connected"],
                "unique_leads": entry["unique_leads"],
                "tt": round(entry["tt"], 2),
                "days": len(entry["days"]),
            }
        )

    bda_leads: dict[str, dict[str, Any]] = {}
    for row in lead_rows:
        key = f"{row['mgr']}|{row['bda']}"
        if key not in bda_leads:
            bda_leads[key] = {"mgr": row["mgr"], "bda": row["bda"], "stages": {}}
        stage = row.get("stage", "")
        bda_leads[key]["stages"][stage] = bda_leads[key]["stages"].get(stage, 0) + 1

    return {
        "bda_revenue": sorted(bda_revenue.values(), key=lambda item: item["full_amount"], reverse=True),
        "bda_productivity": sorted(productivity_rows, key=lambda item: item["calls"], reverse=True),
        "bda_leads": list(bda_leads.values()),
    }


def build_dashboard_payload(
    lead_rows: list[dict[str, Any]],
    input_rows: list[dict[str, Any]],
    token_rows: list[dict[str, Any]],
    full_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build the RAW-compatible object consumed by the existing frontend."""
    lead_dates = [row["date"] for row in lead_rows]
    input_dates = [row["date"] for row in input_rows]
    all_dates = lead_dates + input_dates
    date_min = min(all_dates) if all_dates else config.MONTH_START
    date_max = max(all_dates) if all_dates else config.MONTH_END

    return {
        "gm": config.GM_NAME,
        "lead_rows": lead_rows,
        "input_rows": input_rows,
        "token_rows": token_rows,
        "full_rows": full_rows,
        "full_by_course": count_by_key(full_rows, "type"),
        "token_by_course": count_by_key(token_rows, "type"),
        "leads_by_source": count_by_key(lead_rows, "source"),
        "daily_calls": build_daily_calls(input_rows),
        "date_min": date_min,
        "date_max": date_max,
        "input_date_min": min(input_dates) if input_dates else None,
        "input_date_max": max(input_dates) if input_dates else None,
    }


class DataStore:
    """In-memory cache for processed dashboard datasets."""

    def __init__(self) -> None:
        self.updated_at: str | None = None
        self.last_error: str | None = None
        self.raw_frames: dict[str, pd.DataFrame] = {}
        self.lead_rows: list[dict[str, Any]] = []
        self.input_rows: list[dict[str, Any]] = []
        self.token_rows: list[dict[str, Any]] = []
        self.full_rows: list[dict[str, Any]] = []
        self.dashboard: dict[str, Any] = {}
        self.kpis: dict[str, Any] = {}
        self.funnel: dict[str, Any] = {}
        self.revenue: dict[str, Any] = {}
        self.charts: dict[str, Any] = {}
        self.tables: dict[str, Any] = {}

    def refresh(self) -> None:
        """Fetch all CSVs, clean, filter, and rebuild cached aggregates."""
        frames: dict[str, pd.DataFrame] = {}
        for name, url in config.CSV_URLS.items():
            frames[name] = fetch_csv(name, url)

        # All Siddhartha leads from sheet; date filtering is applied in the frontend
        leads_df = _filter_gm(frames["leads"])
        inputs_df = _filter_gm(frames["inputs"])
        tokens_df = _filter_payment_month(_filter_gm(frames["tokens"]))
        full_df = _filter_payment_month(_filter_gm(frames["fullpayments"]))

        bda_mgr = build_bda_manager_map(leads_df)

        self.lead_rows = process_leads(leads_df)
        self.input_rows = process_inputs(inputs_df, bda_mgr)
        self.token_rows = process_tokens(tokens_df)
        self.full_rows = process_full_payments(full_df)

        self.dashboard = build_dashboard_payload(
            self.lead_rows,
            self.input_rows,
            self.token_rows,
            self.full_rows,
        )
        self.kpis = compute_kpis(self.lead_rows, self.input_rows, self.token_rows, self.full_rows)
        self.funnel = build_funnel(self.lead_rows)
        self.revenue = build_revenue(self.token_rows, self.full_rows)
        self.charts = build_charts(self.lead_rows, self.input_rows, self.token_rows, self.full_rows)
        self.tables = build_tables(self.lead_rows, self.input_rows, self.token_rows, self.full_rows)

        self.raw_frames = {
            "leads": leads_df,
            "inputs": inputs_df,
            "tokens": tokens_df,
            "fullpayments": full_df,
        }
        self.updated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self.last_error = None
        logger.info(
            "Cache refreshed: leads=%s inputs=%s tokens=%s full=%s",
            len(self.lead_rows),
            len(self.input_rows),
            len(self.token_rows),
            len(self.full_rows),
        )

    def as_response(self, data: Any) -> dict[str, Any]:
        return _response(True, data, updated_at=self.updated_at)

    def error_response(self, message: str) -> dict[str, Any]:
        return _response(False, None, updated_at=self.updated_at, error=message)
