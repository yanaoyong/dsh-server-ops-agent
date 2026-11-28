"""Linux integration test with real GPG, duplicity and an isolated rclone filesystem."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time
import unittest

module = Path(__file__).resolve().parents[1] / 'base-backup/google_drive.py'
spec = importlib.util.spec_from_file_location('google_drive', module)
gd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gd)


@unittest.skipUnless(all(shutil.which(c) for c in ('duplicity', 'rclone', 'gpg')), 'requires Linux backup tools')
class WorkspaceTest(unittest.TestCase):
    def test_full_incremental_corruption_and_clean_restore(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            source, repo, cloud, state = [tmp / name for name in ('source', 'repo', 'cloud', 'state')]
            for path in (source, repo, cloud, state):
                path.mkdir()
            key, config = tmp / 'key', tmp / 'rclone.conf'
            key.write_text('integration-test-key')
            config.write_text(f'[dsh-google]\ntype = alias\nremote = {cloud}\n')
            (source / 'README.md').write_text('workspace test')
            (source / 'code.py').write_text('version one')
            with sqlite3.connect(source / 'example.sqlite') as db:
                db.execute('CREATE TABLE sample(id INTEGER)')
            points = []
            for index in range(2):
                if index:
                    time.sleep(2)
                    (source / 'code.py').write_text('updated version two')
                started = int(time.time())
                subprocess.run(['duplicity', '--archive-dir', str(tmp / 'pack-cache'), str(source), repo.as_uri()],
                               env={**os.environ, 'PASSPHRASE': key.read_text()}, check=True, capture_output=True)
                point = {'started': started, 'packed_at': int(time.time()), 'recovery_samples': [
                    {'path': name, 'kind': kind, 'sha256': gd.sha256(source / name)}
                    for name, kind in [('README.md','file'), ('code.py','code'), ('example.sqlite','sqlite')]]}
                gd.publish(point, state, repo, config, key)
                self.assertEqual(gd.read(state / 'latest.json')['started'], started)
                points.append(point)
            self.assertEqual(len(list((cloud / 'receipts').iterdir())), 2)
            self.assertEqual(len(list((cloud / 'volumes').glob('*.manifest.gpg'))), 2)
            # A new host can find the old version from the remote receipt alone.
            first = points[0]
            receipt = json.loads((cloud / 'receipts' / f"{first['started']}.json").read_text())
            gd.restore_sample(first['recovery_samples'][1], receipt['version'], tmp/'old.py',
                              tmp/'disaster-cache', config, key)
            self.assertEqual((tmp/'old.py').read_text(), 'version one')
            volume = next((cloud / 'volumes').glob('*.difftar.gpg'))
            volume.write_bytes(b'broken object')
            with self.assertRaises(ValueError):
                gd.publish(points[-1], state, repo, config, key)
            self.assertEqual(volume.read_bytes(), b'broken object')


if __name__ == '__main__':
    unittest.main()
