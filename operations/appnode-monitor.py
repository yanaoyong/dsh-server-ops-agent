"""One read-only VPS sample. Store only enumerated status fields outside the container."""
import json
import os
import sqlite3
import subprocess
import time
from pathlib import Path

HOME = '/home/appuser'
STORE = Path('/var/lib/dsh-appnode-monitor')
# docker exec failures are missing observations, distinct from HTTP connection failures.
HTTP = {'web': (3000, '/login'), 'engine': (8765, '/health'),
        'secondary': (8775, '/health'), 'share': (3009, '/f/x/y')}


def inside(*args, seconds=6, diagnostics=False):
    try:
        return subprocess.run(['docker', 'exec', '-u', 'appuser', '-e', 'HOME='+HOME, 'appnode', *args],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT if diagnostics else subprocess.DEVNULL, text=True,
                              timeout=seconds, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None


def channels():
    cmd = inside('timeout', '-k', '2', '32', 'nice', '-n', '10',
                 HOME+'/.openclaw/bin/openclaw', 'channels', 'status', '--json', seconds=36, diagnostics=True)
    result = {'feishu': None, 'weixin': None}
    if cmd is None:
        return result
    for pos, char in enumerate(cmd.stdout):
        if char != '{':
            continue
        try:
            data = json.JSONDecoder().raw_decode(cmd.stdout[pos:])[0]['channels']
        except (ValueError, KeyError, TypeError):
            continue
        for key, channel in [('feishu', 'feishu'), ('weixin', 'openclaw-weixin')]:
            status = data.get(channel, {})
            flags = [status.get('running')]
            if key == 'feishu':
                flags.append(status.get('connected'))
            result[key] = False if False in flags else True if all(v is True for v in flags) else None
        break
    if 'gateway not reachable' in cmd.stdout.lower():
        result = dict.fromkeys(result, False)
    return result


def collect(check_channels):
    result = {}
    for key, (port, path) in HTTP.items():
        cmd = inside('curl', '--noproxy', '*', '--max-time', '3', '--silent', '-o', '/dev/null',
                     '-w', '%{http_code}', f'http://127.0.0.1:{port}{path}')
        result[key] = (int(cmd.stdout) if cmd and cmd.returncode == 0 and cmd.stdout.isdigit()
                       else 0 if cmd and cmd.returncode in (7, 28) else None)
    cmd = inside('stat', '-c', '%Y', HOME+'/.local/state/example-indexer/status.txt')
    stamp = int(cmd.stdout) if cmd and cmd.returncode == 0 and cmd.stdout.strip().isdigit() else None
    result['watch'] = int(time.time()) - stamp if stamp else None
    if check_channels:
        result.update(channels())
    return result


if __name__ == '__main__':
    os.umask(0o077)
    slot = int(time.time()) // 60 * 60
    with sqlite3.connect(STORE/'samples.sqlite') as db:
        db.execute('CREATE TABLE IF NOT EXISTS minutes(t INTEGER PRIMARY KEY, data TEXT NOT NULL)')
        if not db.execute('SELECT 1 FROM minutes WHERE t=?', (slot,)).fetchone():
            last = db.execute('SELECT data FROM minutes ORDER BY t DESC LIMIT 1').fetchone()
            values = collect(slot % 300 == 0 or last is None)
            db.execute('INSERT OR IGNORE INTO minutes VALUES(?,?)', (slot, json.dumps(values)))
            db.execute('DELETE FROM minutes WHERE t<?', (slot-30*86400,))
