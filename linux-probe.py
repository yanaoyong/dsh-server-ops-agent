"""Read fixed Linux signals. Emit aggregates only. No log bodies leave the host."""
import hashlib
import http.client
import ipaddress
import json
import math
import grp
import os
import re
import socket
import subprocess
import sys
import time

result = {}


def command(*args):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=5)
        return p.stdout if p.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def signal(name, state, **facts):
    result[name] = dict(state=state, facts=facts)


def listener_addresses(listeners):
    addresses = set()
    for line in listeners.splitlines():
        fields = line.split()
        if len(fields) < 5:
            continue
        address = fields[3].rsplit(':', 1)[0].strip('[]')
        if address == '*':
            addresses.update(('127.0.0.1', '::1'))
            continue
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError:
            continue
        addresses.add(('::1' if parsed.version == 6 else '127.0.0.1') if parsed.is_unspecified else address)
    return sorted(addresses)


def ssh_identification(address, port):
    deadline = time.monotonic() + 1.25
    try:
        with socket.create_connection((address, port), timeout=1.25) as conn:
            reply = b''
            while len(reply) < 1024:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                conn.settimeout(remaining)
                chunk = conn.recv(1024 - len(reply))
                if not chunk:
                    break
                reply += chunk
                if re.search(rb'(?:^|\n)SSH-(?:2\.0|1\.99)-[!-~]+(?: [\x20-\x7e]*)?\r?\n', reply):
                    return True
    except OSError:
        pass
    return False


# Check the enrolled Linux identity before reading service paths or logs.
machine_id = open('/etc/machine-id', 'rb').read().strip()
if not re.fullmatch(rb'[0-9a-fA-F]{32}', machine_id) or machine_id == b'0' * 32:
    sys.exit(2)
identity = hashlib.sha256(machine_id).hexdigest()
if len(sys.argv) == 4 and sys.argv[3] not in ('unbound', identity):
    print(json.dumps({'identity': identity, 'signals': {}}))
    sys.exit(0)

if sys.argv[1:2] == ['--local']:
    port = int(os.environ.get('SERVER_OPS_SSH_PORT', '22'))
    listeners = command('ss', '-H', '-ltn', 'sport', '=', ':' + str(port))
    listening = None if listeners is None else bool(listeners.strip())
    addresses = listener_addresses(listeners or '')
    if listening is None or (listening and not addresses):
        identified = None
    else:
        identified = any(ssh_identification(address, port) for address in addresses[:8])
    state = 'unknown' if identified is None else 'ok' if identified else 'bad'
    signal('本机 SSH 服务', state, port=port, listening=listening, ssh_identification=identified)

s = os.statvfs('/')
pct = math.ceil(100 * (s.f_blocks - s.f_bfree) / max(1, s.f_blocks - s.f_bfree + s.f_bavail))
inode = round(100 * (s.f_files - s.f_ffree) / max(1, s.f_files))
mem = dict(re.findall(r'^(MemTotal|MemAvailable):\s*(\d+)', open('/proc/meminfo').read(), re.M))
free_pct = round(100 * int(mem['MemAvailable']) / int(mem['MemTotal']))
load15 = round(os.getloadavg()[2], 2)
signal('主机容量', 'bad' if pct >= 85 or inode >= 90 or free_pct < 8 or load15 > os.cpu_count() * 1.5 else 'ok',
       root_used_pct=pct, inode_used_pct=inode, available_memory_pct=free_pct, load15=load15,
       logical_cpu=os.cpu_count(), available_bytes=s.f_bavail*s.f_frsize)
end = int(time.time()) // 60 * 60
start = end - 300
lines, full = journal_lines(start, end, 2000)
groups = {grp.getgrgid(i).gr_name for i in os.getgroups()}
visible = os.geteuid() == 0 or bool(groups.intersection({'adm', 'systemd-journal'}))
unit_active = bool(lines) or command('systemctl', 'is-active', '--quiet', 'ssh.service', 'sshd.service', 'ssh.socket', 'sshd.socket') is not None
ban = command('fail2ban-client', 'status', 'sshd') or ''
count = re.search(r'Currently banned:\s*(\d+)', ban)
listed = re.search(r'Banned IP list:[ \t]*([^\r\n]*)', ban)
banned = set(listed.group(1).split()) if listed else None
if banned is not None and (not count or len(banned) != int(count.group(1))):
    banned = None
facts = ssh_failures(lines, start, end, full and visible and unit_active, banned)
state = 'bad' if any(n >= 8 for _, n, _ in facts['top']) else 'ok' if facts['window_complete'] else 'unknown'
signal('可疑 IP', state, **facts, journal_visible=visible, source='sshd journal', threshold=8, max_lines=2000)
signal('fail2ban 既有策略', 'ok' if count else 'unknown', banned=int(count.group(1)) if count else None,
       source='fail2ban sshd jail', checked_at=int(time.time()))
oom = command('journalctl', '--quiet', '--no-pager', '-k', '--since=-5min', '-n', '1500', '-o', 'cat')
oom_count = len(re.findall(r'Out of memory: Killed process|oom-kill:', oom or '', re.I))
signal('内核 OOM', 'bad' if oom_count else 'ok' if oom is not None and visible else 'unknown', observations=oom_count, window_seconds=300)
units = command('systemctl','list-units','--failed','--no-legend','--no-pager','--plain')
signal('失败单元', 'unknown' if units is None else 'bad' if units.strip() else 'ok', count=len((units or '').splitlines()), units=[r.split()[0] for r in (units or '').splitlines()[:12] if r.split() and re.fullmatch(r'[a-zA-Z0-9_.@-]+',r.split()[0])])
print(json.dumps({'identity':identity,'signals':result}))
