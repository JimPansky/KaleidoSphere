import os
from pathlib import Path

def read_secret(name):
    value = Path(f"/run/secrets/{name}").read_text(encoding="utf-8").strip()
    if not value:
        raise RuntimeError(f"{name.upper()}_MISSING")
    return value

SECRET_KEY = read_secret("superset_secret_key")
SQLALCHEMY_DATABASE_URI = "sqlite:////var/lib/chimpmaera-bi/metadata/superset.db"
WTF_CSRF_ENABLED = True
PUBLIC_ROLE_LIKE = None
AUTH_ROLE_PUBLIC = "Public"
ENABLE_PROXY_FIX = False
TALISMAN_ENABLED = False  # bound to localhost by Compose; not a public deployment
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Strict"
PREVENT_UNSAFE_DB_CONNECTIONS = True
SQLLAB_CTAS_NO_LIMIT = False
SQL_MAX_ROW = 1000
UPLOAD_FOLDER = "/var/lib/chimpmaera-bi/metadata/uploads-denied"
ALLOWED_EXTENSIONS = set()
# Preserve Superset 6.1's documented application-level exemptions.  Clearing
# this list breaks the authenticated dashboard SPA: its own telemetry request
# is rejected and Flask redirects the browser to login before charts render.
# This does not disable CSRF globally and does not exempt any custom endpoint.
WTF_CSRF_EXEMPT_LIST = [
    "superset.charts.data.api.data",
    "superset.dashboards.api.cache_dashboard_screenshot",
    "superset.views.core.explore_json",
    "superset.views.core.log",
    "superset.views.datasource.views.samples",
]
FEATURE_FLAGS = {
    "ENABLE_TEMPLATE_PROCESSING": False,
    "ALERT_REPORTS": False,
    "EMBEDDED_SUPERSET": False,
    "HORIZONTAL_FILTER_BAR": True,
}
MENU_LINKS = [{
    "name": "KaleidoSphere",
    "label": "KaleidoSphere",
    "url": os.environ.get("AGENT_PUBLIC_URL", "http://localhost:18790"),
    "icon": "fa-robot",
}]
