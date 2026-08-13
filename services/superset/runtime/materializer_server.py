import hmac
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from materialize import materialize

TOKEN = Path("/run/secrets/control_token").read_text(encoding="utf-8").strip()

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
        if self.path == "/healthz":
            self.send_json(200, {"status":"ok"})
        else:
            self.send_json(404, {"status":"DENIED","code":"SUPERSET_INTERNAL_ROUTE_DENIED"})

    def do_POST(self):
        try:
            supplied = self.headers.get("Authorization", "").removeprefix("Bearer ")
            if not TOKEN or not hmac.compare_digest(supplied, TOKEN):
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
