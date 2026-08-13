#!/usr/bin/env bash
set -euo pipefail
python /opt/chimpmaera-bi/materializer_server.py &
exec gunicorn \
  --bind 0.0.0.0:8088 \
  --workers 2 \
  --worker-class gthread \
  --threads 10 \
  --timeout 120 \
  --access-logfile - \
  --error-logfile - \
  'superset.app:create_app()'
