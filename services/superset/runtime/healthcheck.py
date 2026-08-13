import urllib.request

for url, expected in (("http://127.0.0.1:8088/health", b"OK"), ("http://127.0.0.1:8090/healthz", b'{"status":"ok"}\n')):
    with urllib.request.urlopen(url, timeout=3) as response:
        if response.status != 200 or response.read() != expected:
            raise SystemExit(1)
