"""Hold the per-account scheduler lock through exec, including process crashes."""
import fcntl
import os
from pathlib import Path
import sys

os.umask(0o077)
root = Path(os.environ.get('SERVER_OPS_STATE', Path.home()/'Library/Application Support/server-ops-agent'))
root.mkdir(mode=0o700, parents=True, exist_ok=True)
fd = os.open(root/'scheduler.lock', os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit('值班进程已经运行')
os.set_inheritable(fd, True)
os.execv(sys.argv[1], [sys.argv[1], str(Path(__file__).with_name('agent.js'))])
