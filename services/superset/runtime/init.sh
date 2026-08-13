#!/usr/bin/env bash
set -euo pipefail
umask 077
mkdir -p /var/lib/chimpmaera-bi/metadata /var/lib/chimpmaera-bi/projection
superset db upgrade
superset init
python /opt/chimpmaera-bi/bootstrap.py
