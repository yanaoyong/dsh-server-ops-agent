"""Forward one line of JSON from SSH to the local read-only service."""

import http.client
import json
import os
import socket
import sys

REQUEST_LIMIT = 1024 * 1024
RESPONSE_LIMIT = 16 * 1024 * 1024


class LocalConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/run/server-ops-agent/control.sock')


def main():
    request = sys.stdin.buffer.readline(REQUEST_LIMIT + 2)
    if not request.endswith(b'\n') or len(request) > REQUEST_LIMIT + 1:
        raise ValueError('请求格式或大小无效')
    with_connection = LocalConnection('localhost', timeout=10)
    try:
        with_connection.request('POST', '/', body=request[:-1], headers={'Content-Type': 'application/json'})
        reply = with_connection.getresponse().read(RESPONSE_LIMIT + 1)
        if len(reply) > RESPONSE_LIMIT:
            raise ValueError('结果超过大小上限')
        sys.stdout.buffer.write(reply + b'\n')
    finally:
        with_connection.close()


if __name__ == '__main__':
    try:
        main()
    except PermissionError:
        print(json.dumps({'error': '当前 SSH 用户没有运维服务读取权限'}))
    except (OSError, http.client.HTTPException):
        print(json.dumps({'error': 'Linux 运维服务尚未就绪'}))
    except ValueError as error:
        print(json.dumps({'error': str(error)}))
