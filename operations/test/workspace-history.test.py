"""Production duplicity interface, two real versions, and selective restore."""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
import unittest.mock

script = Path(__file__).resolve().parents[1] / 'base-backup/workspace_history.py'
spec = importlib.util.spec_from_file_location('history', script)
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)


class TimeWindowTest(unittest.TestCase):
    def test_selects_adjacent_versions_and_paginates_candidates(self):
        day = history.datetime(2024, 11, 25, tzinfo=history.BEIJING)
        stamps = [int((day+history.timedelta(hours=h)).timestamp()) for h in (9,15,21)]
        versions = [dict(point=t, version=str(t), google=False, baidu=True) for t in stamps]
        query = dict(day="2024-11-25", fromTime="10:00", untilTime="20:00")
        with unittest.mock.patch.object(history, 'missing_paths', side_effect=lambda *args: (f'project/{i}' for i in range(32))):
            rows = history.investigate(versions, query)
            self.assertEqual((rows['intervalCount'],rows['restorePoint'],rows['nextOffset']), (2,stamps[0],20))
            self.assertEqual(history.investigate(versions, dict(query,intervalIndex=1))['restorePoint'], stamps[1])
            tail = history.investigate(versions, dict(query,offset=20))
            self.assertEqual((len(tail['candidates']),tail['nextOffset']), (12,None))
            self.assertTrue(rows['coveredStart'] and rows['coveredEnd'])
            self.assertFalse(history.investigate(versions, dict(query,untilTime='23:00'))['coveredEnd'])


@unittest.skipUnless(shutil.which('duplicity'), 'requires duplicity')
class HistoryTest(unittest.TestCase):
    def test_browse_deleted_directory_and_restore_to_new_location(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            history.BASE = base
            history.REPO = base / 'repo'
            history.ROOT = base / 'history'
            history.PRIVATE = base / 'private'
            source = base / 'source'
            name = "项目 '一'"
            for path in (history.REPO, history.PRIVATE, base / 'sealed', source / name):
                path.mkdir(parents=True)
            (history.PRIVATE / 'duplicity.key').write_text('fixture-password')
            selected = [name + '/旧 文件.txt', name + '/a\nb']
            for path in selected:
                (source / path).write_text(path)
            (source / 'link').symlink_to('/nonexistent')
            times = []
            for revision in range(2):
                if revision:
                    shutil.rmtree(source / name)
                    (source / 'today').write_text('today')
                    time.sleep(2)
                start = int(time.time())
                subprocess.run(['duplicity', '--archive-dir', str(base / 'archive-cache-v2'), str(source), history.REPO.as_uri()],
                               env=history.environment(), check=True, capture_output=True)
                (base / 'sealed' / f'{start}.json').write_text(history.json.dumps({
                    'started': start, 'packed_at': int(time.time())}))
                times.append(start)
            self.assertEqual(len(history.points()), 2)
            for point in history.points():
                self.assertTrue(history.cached_signatures(point['version']))
            day = history.datetime.fromtimestamp(times[0], history.BEIJING).date().isoformat()
            args = dict(day=day, fromTime='00:00', untilTime='24:00')
            changes = history.handle('changes', args)
            self.assertEqual(set(changes['candidates']), {name, *selected})
            self.assertEqual(changes['restorePoint'], times[0])
            self.assertFalse(changes['coveredStart'])
            self.assertFalse(changes['coveredEnd'])
            with unittest.mock.patch.object(history, 'cached_signatures', return_value=[]):
                filtered = history.handle('changes', dict(args, directory=name, keyword='旧 文件'))
                self.assertEqual(filtered['candidates'], [selected[0]])
            self.assertFalse(history.handle('changes', dict(args, day='2000-01-01'))['candidates'])
            old = dict(point=times[0], path=name)
            self.assertEqual({r['name'] for r in history.handle('browse', old)['items']}, {'旧 文件.txt', 'a\nb'})
            self.assertTrue(history.handle('browse', dict(point=times[1], path=name))['missing'])
            request = dict(**old, paths=selected, requestId='a'*32, source='local')
            result = history.handle('restore', request)
            for path in selected:
                self.assertEqual((Path(result['directory']) / path).read_text(), path)
            self.assertEqual(history.handle('restore', request), result)
            for paths in (['../x'], ['link'], ['today']):
                with self.assertRaises(ValueError):
                    history.handle('restore', dict(request, paths=paths))
            directory = history.handle('restore', dict(request, paths=[name], requestId='b'*32))
            self.assertTrue((Path(directory['directory']) / selected[0]).exists())
            self.assertFalse((source / name).exists())
            if shutil.which('rclone'):
                cloud = base / 'cloud'
                shutil.copytree(history.REPO, cloud / 'volumes')
                (history.PRIVATE / 'google-drive.conf').write_text(
                    f'[dsh-google]\ntype = alias\nremote = {cloud}\nroot_folder_id = fixture\n')
                verified = base / 'google-drive/fixture/receipts'
                verified.mkdir(parents=True)
                first = history.points()[-1]
                (verified / f'{times[0]}.json').write_text(history.json.dumps({'version': first['version']}))
                remote = history.handle('restore', dict(request, source='google', requestId='c'*32))
                for path in selected:
                    self.assertEqual((Path(remote['directory']) / path).read_text(), path)
                with self.assertRaises(ValueError):
                    history.handle('restore', dict(request, point=times[1], source='google', paths=['today']))



if __name__ == '__main__':
    unittest.main()
