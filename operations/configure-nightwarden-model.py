"""Configure the selected model on the enrolled NightWarden instance."""
import json
import os
import shlex
import sqlite3
import subprocess
from pathlib import Path

STATE = Path(os.environ.get('SERVER_OPS_STATE', Path.home() / 'Library/Application Support/server-ops-agent'))
REMOTE = """
import hashlib,json,pathlib,sys,urllib.request,urllib.error
identity=hashlib.sha256(pathlib.Path('/etc/machine-id').read_bytes().strip()).hexdigest()
print(identity,flush=True)
cfg=json.load(sys.stdin)
if not cfg['model'] or not cfg['baseUrl'].startswith('https://'): sys.exit(2)
secret=pathlib.Path('/opt/dsh-nightwarden/private/nightwarden.json')
assert secret.is_file() and not secret.is_symlink() and secret.stat().st_mode & 0o077 == 0
cookie=json.loads(secret.read_bytes())['cookie']
origin='http://127.0.0.1:18791'
def api(method,path,data=None):
    req=urllib.request.Request(origin+path,method=method,headers={'Cookie':cookie,'Origin':origin,'Content-Type':'application/json'},data=json.dumps(data).encode() if data else None)
    try:
        with urllib.request.urlopen(req,timeout=110) as r: return json.load(r)
    except urllib.error.HTTPError as e:
        print('NightWarden',path,'HTTP',e.code,flush=True);sys.exit(3)
kind='openai-compatible'
check=api('POST','/api/config/model-check',dict(cfg,provider=kind))
if not check.get('ok'):
    reason=check.get('reason')
    print('模型工具调用未通过',reason if reason in ('needs_url','auth','timeout','no_tool_call','request_failed','unsupported') else '模型检查未通过',flush=True)
    sys.exit(4)
api('PATCH','/api/config/key',{'provider':kind,'apiKey':cfg['apiKey']})
api('PATCH','/api/config',{'provider':kind,'providers':{kind:{'model':cfg['model'],'baseUrl':cfg['baseUrl']}}})
read=api('GET','/api/config')
assert read['provider']==kind and read['providers'][kind]['model']==cfg['model']
print(json.dumps({'provider':kind,'model':cfg['model'],'modelToolCall':'verified','configReadback':'verified'}),flush=True)
"""


def main():
    with sqlite3.connect((STATE/'ledger.sqlite').as_uri()+'?mode=ro',uri=True) as db:
        alias,expected=db.execute("SELECT alias,machine FROM workbench_hosts h JOIN identities i ON i.host=h.id WHERE h.id='example-host'").fetchone()
    ssh=subprocess.Popen(['/usr/bin/ssh','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oForwardAgent=no',
        '-oUpdateHostKeys=no','-oClearAllForwardings=yes','-oConnectTimeout=8','-T','--',alias,'python3 -I -c '+shlex.quote(REMOTE)],
        stdin=subprocess.PIPE,stdout=subprocess.PIPE)
    try:
        if ssh.stdout.readline().decode().strip()!=expected:
            raise SystemExit('已登记的机器摘要未匹配')
        payload=json.dumps({'apiKey':os.environ['DSH_MODEL_API_KEY'],
                            'baseUrl':os.environ['DSH_MODEL_BASE_URL'],
                            'model':os.environ['DSH_MODEL_ID']}).encode()
        output=ssh.communicate(payload,timeout=200)[0]
        print(output.decode().strip())
        raise SystemExit(ssh.returncode)
    finally:
        if ssh.poll() is None: ssh.kill();ssh.wait()


if __name__=='__main__':
    main()
