import hmac
import importlib.metadata
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import superset
from flask_appbuilder.api import BaseApi
from flask_appbuilder.api.manager import OpenApi

from materialize import APP, materialize

TOKEN = Path("/run/secrets/control_token").read_text(encoding="utf-8").strip()
PUBLIC_URL = "http://superset:8088"

def authorized(headers):
    supplied = headers.get("Authorization", "").removeprefix("Bearer ")
    return TOKEN and hmac.compare_digest(supplied, TOKEN)

def openapi_document():
    with APP.app_context():
        with APP.test_request_context(base_url=PUBLIC_URL):
            api_spec = OpenApi._create_api_spec("v1")
            version_found = False
            for base_api in APP.appbuilder.baseviews:
                if isinstance(base_api, BaseApi) and base_api.version == "v1":
                    base_api.add_api_spec(api_spec)
                    version_found = True
            if not version_found:
                raise RuntimeError("SUPERSET_OPENAPI_ENDPOINT_UNAVAILABLE")
            return api_spec.to_dict()

def runtime_fingerprint_evidence():
    with APP.app_context():
        version = getattr(superset, "__version__", "") or importlib.metadata.version("apache-superset")
        return {
            "schemaVersion": "chimpmaera.bi/superset-runtime-evidence/v1",
            "observedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
            "target": {"baseUrl": PUBLIC_URL},
            "product": {
                "name": "Apache Superset",
                "version": version,
                "source": {"kind": "apache-superset-python-package", "package": "apache-superset"},
            },
            "openapi": {
                "source": {"kind": "flask-appbuilder-openapi", "path": "/api/v1/_openapi", "url": f"{PUBLIC_URL}/api/v1/_openapi"},
                "contentType": "application/json",
                "document": openapi_document(),
            },
            "featureFlags": {
                "source": {"kind": "local-superset-runtime-config", "name": "FEATURE_FLAGS", "path": "services/superset/runtime/superset_config.py"},
                "values": dict(APP.config.get("FEATURE_FLAGS", {})),
            },
            "provenance": [
                {"kind": "runtime", "component": "superset", "readOnly": True},
                {"kind": "runtime-config", "field": "FEATURE_FLAGS", "readOnly": True},
            ],
        }

class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return

    def send_json(self, status, value):
        body = (json.dumps(value, separators=(",", ":")) + "\n").encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            if self.path == "/healthz":
                self.send_json(200, {"status":"ok"})
            elif self.path == "/internal/fingerprint":
                if not authorized(self.headers):
                    raise RuntimeError("SUPERSET_INTERNAL_AUTH_DENIED")
                self.send_json(200, runtime_fingerprint_evidence())
            else:
                self.send_json(404, {"status":"DENIED","code":"SUPERSET_INTERNAL_ROUTE_DENIED"})
        except Exception as error:
            code = str(error).replace(" ", "_")
            if not code.isupper() or len(code) > 128:
                code = "SUPERSET_FINGERPRINT_DENIED"
            self.send_json(401 if code == "SUPERSET_INTERNAL_AUTH_DENIED" else 400, {"status":"DENIED","code":code})

    def do_POST(self):
        try:
            if not authorized(self.headers):
                raise RuntimeError("SUPERSET_INTERNAL_AUTH_DENIED")
            if self.path != "/internal/materialize":
                raise RuntimeError("SUPERSET_INTERNAL_ROUTE_DENIED")
            size = int(self.headers.get("Content-Length", "0"))
            if size < 2 or size > 16384:
                raise RuntimeError("SUPERSET_INTERNAL_BODY_DENIED")
            request = json.loads(self.rfile.read(size))
            self.send_json(200, materialize(request))
        except Exception as error:
            code = str(error).replace(" ", "_")
            if not code.isupper() or len(code) > 128:
                code = "SUPERSET_MATERIALIZATION_DENIED"
            self.send_json(401 if code == "SUPERSET_INTERNAL_AUTH_DENIED" else 400, {"status":"DENIED","code":code})

ThreadingHTTPServer(("0.0.0.0", 8090), Handler).serve_forever()
