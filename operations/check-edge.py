"""Probe the registered Caddy routes with TLS verification and a loopback connection."""
import concurrent.futures
import json
import socket
import ssl
import time
import re
import subprocess
import sys
from pathlib import Path

EDGE_TARGETS = {
    "base:3080": 200,
    "appnode:3080": 200,
    "example-site:8080": 401,
}


def registered_sites():
    """Read literal site addresses from this installation's Caddyfile."""
    routes = {target: set() for target in EDGE_TARGETS}
    domains = set()
    lines = Path("/opt/example-edge/Caddyfile").read_text().splitlines()
    domain = None
    for line in lines:
        site = re.fullmatch(r"([a-zA-Z0-9][a-zA-Z0-9.-]*)\s*\{\s*", line)
        if line and not line[0].isspace() and not line.startswith("#"):
            domain = site.group(1).lower() if site else None
            if domain:
                domains.add(domain)
        match = re.match(r"\s*reverse_proxy\s+(?:http://)?([^\s{]+)(?:\s|$)", line)
        if domain and match and match.group(1) in routes:
            routes[match.group(1)].add(domain)
    return domains, routes


def certificate_result(expiry, observed):
    remaining = expiry - observed
    level = "event" if remaining <= 3*86400 else "report" if remaining <= 14*86400 else "normal"
    return {"state": "bad" if level == "event" else "ok",
            "facts": {"expires": expiry, "checked_at": observed, "level": level}}


def certificate_observations(domains):
    context = ssl.create_default_context()
    def inspect(domain):
        try:
            with socket.create_connection(("127.0.0.1", 443), timeout=2) as conn:
                with context.wrap_socket(conn, server_hostname=domain) as tls:
                    expires = int(ssl.cert_time_to_seconds(tls.getpeercert()["notAfter"]))
                    return certificate_result(expires, int(time.time()))
        except ssl.SSLCertVerificationError as err:
            # A validation failure must never close an existing expiry event.
            # Code 10 is an expired leaf or issuer, even if the handshake aborts.
            if err.verify_code == 10:
                return {"state":"bad","facts":{"level":"event","reason":"服务证书或证书链已过期"}}
            reason = "证书身份或信任链验证失败"
        except (OSError, KeyError, ValueError):
            reason = "未能取得服务证书"
        return {"state":"unknown","facts":{"reason":reason}}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        names = sorted(domains)
        return dict(zip(names, pool.map(inspect, names)))


def edge_observations(routes=None):
    if routes is None:
        try:
            _, routes = registered_sites()
        except (OSError, UnicodeError):
            routes = {target: set() for target in EDGE_TARGETS}
    observations = {}
    for target, expected in EDGE_TARGETS.items():
        facts = {"transport": "HTTPS loopback, TLS verified", "expected_http": expected}
        observations[target] = facts
        if len(routes[target]) != 1:
            facts["reason"] = "未能唯一识别已登记的代理路由"
            continue
        domain = next(iter(routes[target]))
        try:
            probe = subprocess.run([
                "curl", "--disable", "--silent", "--noproxy", "*", "--max-time", "4",
                "--resolve", f"{domain}:443:127.0.0.1", "--output", "/dev/null",
                "--write-out", "%{http_code} %{time_total}", f"https://{domain}/",
            ], capture_output=True, text=True, timeout=5)
            code, seconds = probe.stdout.split()
            facts.update(code=int(code), elapsed_ms=round(1000*float(seconds)), curl_exit=probe.returncode)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            facts["reason"] = "代理探针未返回可解析的回执"
    return observations


if __name__ == "__main__" and len(sys.argv) == 1:
    print(json.dumps(edge_observations(), ensure_ascii=False, indent=2))
