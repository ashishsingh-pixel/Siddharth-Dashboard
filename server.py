"""Local Flask proxy server for the Siddhartha live analytics dashboard."""

from __future__ import annotations

import logging
import threading

from apscheduler.schedulers.background import BackgroundScheduler
from flask import Flask, jsonify, render_template, send_from_directory
from flask_cors import CORS

import config
from data_processor import DataStore

logging.basicConfig(
    level=logging.DEBUG if config.DEBUG else logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("dashboard-server")

app = Flask(__name__, static_folder="static", template_folder="templates")
CORS(app)

store = DataStore()
store_lock = threading.Lock()
scheduler = BackgroundScheduler(daemon=True)


def refresh_data() -> None:
    """Thread-safe cache refresh used on startup and by the scheduler."""
    with store_lock:
        try:
            store.refresh()
        except Exception as exc:  # noqa: BLE001 - surface upstream CSV/network failures cleanly
            store.last_error = str(exc)
            logger.exception("Data refresh failed")



@app.route("/")
def index():
    return render_template("index.html")


@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory(app.static_folder, filename)


@app.route("/api/health")
def health():
    healthy = store.updated_at is not None and store.last_error is None
    status_code = 200 if healthy else 503
    return (
        jsonify(
            {
                "success": healthy,
                "updated_at": store.updated_at,
                "status": "ok" if healthy else "degraded",
                "last_error": store.last_error,
                "gm_name": config.GM_NAME,
                "payment_month": config.PAYMENT_MONTH,
                "refresh_interval_minutes": config.REFRESH_INTERVAL_MINUTES,
            }
        ),
        status_code,
    )


@app.route("/api/leads")
def api_leads():
    if store.last_error and not store.lead_rows:
        return jsonify(store.error_response(store.last_error)), 503
    return jsonify(store.as_response(store.lead_rows))


@app.route("/api/inputs")
def api_inputs():
    if store.last_error and not store.input_rows:
        return jsonify(store.error_response(store.last_error)), 503
    return jsonify(store.as_response(store.input_rows))


@app.route("/api/tokens")
def api_tokens():
    if store.last_error and not store.token_rows:
        return jsonify(store.error_response(store.last_error)), 503
    return jsonify(store.as_response(store.token_rows))


@app.route("/api/fullpayments")
def api_fullpayments():
    if store.last_error and not store.full_rows:
        return jsonify(store.error_response(store.last_error)), 503
    return jsonify(store.as_response(store.full_rows))


@app.route("/api/kpis")
def api_kpis():
    if store.last_error and not store.kpis:
        return jsonify(store.error_response(store.last_error)), 503
    return jsonify(store.as_response(store.kpis))


@app.route("/api/funnel")
def api_funnel():
    if store.last_error and not store.funnel:
        return jsonify(store.error_response(store.last_error)), 503
    return jsonify(store.as_response(store.funnel))


@app.route("/api/revenue")
def api_revenue():
    if store.last_error and not store.revenue:
        return jsonify(store.error_response(store.last_error)), 503
    return jsonify(store.as_response(store.revenue))


@app.route("/api/charts")
def api_charts():
    if store.last_error and not store.charts:
        return jsonify(store.error_response(store.last_error)), 503
    return jsonify(store.as_response(store.charts))


@app.route("/api/tables")
def api_tables():
    if store.last_error and not store.tables:
        return jsonify(store.error_response(store.last_error)), 503
    return jsonify(store.as_response(store.tables))


@app.route("/api/dashboard")
def api_dashboard():
    """Composite endpoint returning the RAW-compatible payload for the existing UI."""
    if store.last_error and not store.dashboard:
        return jsonify(store.error_response(store.last_error)), 503
    return jsonify(store.as_response(store.dashboard))


@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    refresh_data()
    if store.last_error:
        return jsonify(store.error_response(store.last_error)), 503
    return jsonify(store.as_response({"message": "Refresh complete"}))


def start_scheduler() -> None:
    scheduler.add_job(
        refresh_data,
        "interval",
        minutes=config.REFRESH_INTERVAL_MINUTES,
        id="csv_refresh",
        replace_existing=True,
    )
    scheduler.start()
    logger.info("Background refresh scheduled every %s minutes", config.REFRESH_INTERVAL_MINUTES)


if __name__ == "__main__":
    logger.info("Starting Siddhartha live dashboard server")
    refresh_data()
    start_scheduler()
    app.run(host=config.HOST, port=config.PORT, debug=config.DEBUG, use_reloader=False)
