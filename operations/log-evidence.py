"""Aggregate bounded Linux logs on the registered host; emit no raw messages."""
import collections
import ipaddress
import json
import re
import subprocess


def log_lines(args, limit):
    max_bytes = 2 * 1024 * 1024
    try:
        with subprocess.Popen(['timeout', '--kill-after=1s', '5s', *args],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as proc:
            raw = proc.stdout.read(max_bytes + 1)
            clipped = len(raw) > max_bytes
            if clipped:
                proc.kill()
            rc = proc.wait()
    except OSError:
        return [], False
    lines = raw[:max_bytes].decode('utf-8', errors='replace').splitlines()
    if clipped and lines:
        lines.pop()
    return lines[-limit:], rc == 0 and not clipped and len(lines) <= limit


def ssh_failures(lines, start, end, complete, banned=None):
    per_source = {}
    minutes = [0] * ((end - start) // 60)
    valid = True
    for line in lines:
        try:
            row = json.loads(line)
            ts = int(row['__REALTIME_TIMESTAMP']) // 1000000
            message = row['MESSAGE']
            if not isinstance(message, str):
                valid = False
                continue
        except (KeyError, TypeError, ValueError):
            valid = False
            continue
        if not start <= ts < end:
            continue
        match = re.match(r'^Failed (?:password|publickey|keyboard-interactive(?:/pam)?|none) for .+ from ([0-9a-fA-F:.]+) port [0-9]+\b', message)
        if match:
            try:
                addr = str(ipaddress.ip_address(match.group(1)))
            except ValueError:
                valid = False
                continue
            slot = (ts - start) // 60
            minutes[slot] += 1
            buckets = per_source.setdefault(addr, collections.Counter())
            buckets[slot] += 1
    ranked = sorted(per_source, key=lambda addr: (-sum(per_source[addr].values()), addr))
    top = [[addr, sum(per_source[addr].values()),
            {'by_minute': [per_source[addr][i] for i in range(len(minutes))],
             'in_existing_ban_list': None if banned is None else addr in banned}] for addr in ranked[:8]]
    return dict(window_start=start, window_end=end, window_seconds=end-start, rows_scanned=len(lines),
                window_complete=bool(complete and valid), minute_failures=minutes,
                observed_failures=sum(minutes), distinct_sources=len(ranked), top=top)


def proxy_access(lines, start, end, complete):
    codes = collections.Counter()
    errors = 0
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict):
            continue
        logger = str(record.get('logger', ''))
        if logger == 'http.log.error':
            errors += 1
        if not logger.startswith('http.log.access') or not isinstance(record.get('request'), dict):
            continue
        code = record.get('status')
        if type(code) is int and 100 <= code <= 599:
            codes[code // 100] += 1
        else:
            complete = False
    total = sum(codes.values())
    return dict(window_start=start, window_end=end, access_records=total, server_errors=codes[5],
                client_errors=codes[4], error_log_records=errors, stream_complete=complete,
                observed_5xx_pct=round(codes[5]*100/total, 2) if total and complete else None,
                source='example-gateway stdout/stderr')


def journal_lines(start, end, limit):
    return log_lines(['journalctl', '-q', '--no-pager', '-u', 'ssh.service', '-u', 'sshd.service',
                      '--since', '@'+str(start), '--until', '@'+str(end),
                      '-n', str(limit + 1), '-o', 'json', '--output-fields=MESSAGE'], limit)
