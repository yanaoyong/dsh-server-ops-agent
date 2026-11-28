import importlib.util
import json
import shutil
import sqlite3
import time
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / f'base-backup/{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class QueueTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which('duplicity') and shutil.which('rsync'), 'requires Linux backup tools')
    def test_capture_new_increment_while_both_destinations_are_pending(self):
        w = load('workspace')
        with tempfile.TemporaryDirectory() as t:
            w.ROOT = Path(t)
            w.STAGE, w.SOURCE, w.CREDS, w.REPO = [w.ROOT / n for n in ('stage','source','private','repo')]
            for path in (w.STAGE,w.SOURCE,w.CREDS,w.ROOT/'tmp'):
                path.mkdir()
            (w.ROOT/'owner').write_text('DSH base workspace backup v1')
            (w.CREDS/'duplicity.key').write_text('fixture')
            (w.SOURCE/'README.md').write_text('first')
            (w.SOURCE/'task.py').write_text('print(1)')
            with sqlite3.connect(w.SOURCE/'test.db') as db:
                db.execute('CREATE TABLE note(id INTEGER)')
            mounts = json.dumps([dict(Type='bind',Source=str(w.SOURCE),Destination='/workspace')]).encode()
            with patch.object(w.subprocess,'check_output',return_value=mounts), patch.object(w.os.path,'ismount',return_value=True):
                w.capture()
                w.capture()
                self.assertEqual(len(list((w.ROOT/'sealed').glob('*.json'))), 1)
                time.sleep(2)
                (w.SOURCE/'README.md').write_text('second version')
                w.capture(force=True)
            sealed = [json.loads(p.read_text()) for p in sorted((w.ROOT/'sealed').glob('*.json'))]
            self.assertEqual(len(sealed),2)
            self.assertNotEqual(sealed[0]['witness_sha256'],sealed[1]['witness_sha256'])
            self.assertEqual(len(list(w.REPO.glob('duplicity-inc.*.manifest.gpg'))),1)
            self.assertFalse((w.ROOT/'latest.json').exists())
            self.assertTrue(all(row['sqlite_count']==1 and row['version'] for row in sealed))

    def test_google_can_verify_again_before_baidu_finishes(self):
        g = load('google_drive')
        with tempfile.TemporaryDirectory() as t:
            g.BASE = Path(t)
            sealed = g.BASE / 'sealed'
            sealed.mkdir()
            row = dict(started=10, packed_at=12, recovery_samples=[{'path':'README.md'}])
            (sealed/'10.json').write_text(json.dumps(row))
            self.assertEqual(g.source(), row)

    def test_migrate_pending_then_capture_without_waiting_for_upload(self):
        w = load('workspace')
        with tempfile.TemporaryDirectory() as t:
            w.ROOT = Path(t)
            w.REPO = w.ROOT / 'volumes-v2'
            w.REPO.mkdir()
            (w.ROOT/'owner').write_text('DSH base workspace backup v1')
            first = 1700000000
            version = w.time.strftime('%Y%m%dT%H%M%SZ',w.time.gmtime(first+10))
            (w.REPO/f'duplicity-full.{version}.manifest.gpg').touch()
            w.save(w.ROOT/'pending.json',dict(started=first,packed_at=first+30,status='uploading',recovery_samples=[{}]))
            mounts = json.dumps([dict(Type='bind',Source=str(w.SOURCE),Destination='/workspace')]).encode()
            with patch.object(w.subprocess,'check_output',return_value=mounts), patch.object(w.os.path,'ismount',return_value=True), patch.object(w,'stamp',return_value=first+60):
                w.capture()
                w.capture()
            sealed = w.ROOT / 'sealed' / f'{first}.json'
            self.assertEqual(json.loads(sealed.read_text())['version'], version)
            self.assertFalse((w.ROOT/'pending.json').exists())
            second = first+21600
            w.save(w.ROOT/'sealed'/f'{second}.json',dict(started=second))
            sent = []
            def publish(row):
                sent.append(row['started'])
                if len(sent)==2: raise RuntimeError('network offline')
                row['status']='verified'
            with patch.object(w,'publish',side_effect=publish):
                with self.assertRaises(RuntimeError): w.publish_queue()
                w.publish_queue()
            self.assertEqual(sent, [first,second,second])
            self.assertEqual(json.loads((w.ROOT/'latest.json').read_text())['started'],second)
            boundary = 21600*80000-8*3600
            self.assertEqual(w.slot(boundary), w.slot(boundary-1)+1)


if __name__=='__main__':
    unittest.main()
