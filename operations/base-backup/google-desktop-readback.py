"""Read an encrypted restic repository through the Mac's signed-in Drive desktop client."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

DIRECTORIES = {'keys', 'snapshots', 'index', 'data', 'locks'}


class Reader(BaseHTTPRequestHandler):
    # Closing each loopback response lets restic retry a truncated range read
    # if the Docker Desktop port forward drops its final bytes.
    protocol_version = 'HTTP/1.0'

    def log_message(self, *args):
        pass

    def do_HEAD(self):
        self.serve(False)

    def do_GET(self):
        self.serve(True)

    def serve(self, send_body):
        supplied = self.headers.get('Authorization', '')
        if not hmac.compare_digest(hashlib.sha256(supplied.encode()).hexdigest(), self.server.auth):
            self.send_error(401)
            return
        parts = urlsplit(self.path).path.strip('/').split('/')
        try:
            if len(parts) == 1 and parts[0] in DIRECTORIES:
                folder = self.server.root / parts[0]
                files = folder.glob('*/*') if parts[0] == 'data' else folder.iterdir()
                v2 = 'application/vnd.x.restic.rest.v2' in self.headers.get('Accept', '')
                entries = [({'name': f.name, 'size': f.stat().st_size} if v2 else f.name)
                           for f in files if re.fullmatch('[a-f0-9]{64}', f.name)]
                self.reply(json.dumps(entries).encode(), send_body, 'application/vnd.x.restic.rest.v2' if v2 else 'application/json')
                return
            if parts == ['config']:
                path = self.server.root / 'config'
            elif len(parts) == 2 and parts[0] in DIRECTORIES and re.fullmatch('[a-f0-9]{64}', parts[1]):
                path = self.server.root / parts[0]
                if parts[0] == 'data':
                    path = path / parts[1][:2]
                path = path / parts[1]
            else:
                self.send_error(404)
                return
            size = path.stat().st_size
            start, end = 0, size - 1
            partial = self.headers.get('Range')
            if partial:
                match = re.fullmatch(r'bytes=(\d+)-(\d*)', partial)
                if not match:
                    self.send_error(416)
                    return
                start = int(match[1])
                end = min(int(match[2]), end) if match[2] else end
                if start > end:
                    self.send_error(416)
                    return
            length = end - start + 1
            if send_body:
                with path.open('rb') as f:
                    f.seek(start)
                    body = f.read(length)
                if len(body) != length:
                    raise OSError('incomplete file provider read')
            self.send_response(206 if partial else 200)
            if partial:
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(length))
            self.send_header('Accept-Ranges', 'bytes')
            self.end_headers()
            if send_body:
                self.wfile.write(body)
        except FileNotFoundError:
            self.send_error(404)
        except (BrokenPipeError, ConnectionResetError):
            return
        except OSError:
            self.send_error(503)

    def reply(self, data, send_body, content_type):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if send_body:
            self.wfile.write(data)


if __name__ == '__main__':
    port, directory = sys.argv[1:]
    root = Path(directory)
    if not (root / 'config').is_file():
        raise SystemExit('repository config unavailable')
    with ThreadingHTTPServer(('127.0.0.1', int(port)), Reader) as server:
        server.auth = sys.stdin.readline().strip()
        if not re.fullmatch('[0-9a-f]{64}', server.auth):
            raise SystemExit('missing relay verifier')
        server.root = root
        server.serve_forever()
