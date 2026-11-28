import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from requests.exceptions import ReadTimeout


spec = importlib.util.spec_from_file_location(
    'workspace', Path(__file__).resolve().parents[1] / 'base-backup' / 'workspace.py'
)
workspace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workspace)


class BaiduRecoveryDownloadTest(unittest.TestCase):
    def test_api_credential_is_private_and_rotation_is_seen_on_next_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'token'
            path.write_text('fixture-one')
            path.chmod(0o600)
            with patch.object(workspace, 'TOKEN_FILE', path):
                self.assertEqual(workspace.baidu_access_token(), 'fixture-one')
                path.write_text('fixture-two')
                self.assertEqual(workspace.baidu_access_token(), 'fixture-two')
                path.chmod(0o644)
                with self.assertRaises(ValueError):
                    workspace.baidu_access_token()
            link = Path(tmp) / 'link'
            link.symlink_to(path)
            with patch.object(workspace, 'TOKEN_FILE', link), self.assertRaises(OSError):
                workspace.baidu_access_token()

    def test_metadata_matches_requested_objects_and_backs_off_on_406(self):
        rows = [{'fs_id': 1, 'server_filename': 'first', 'size': 3},
                {'fs_id': 2, 'server_filename': 'second', 'size': 4}]
        url = 'https://d.pcs.baidu.com/file/'
        limited = self.response(406, {'errno': 20012, 'request_id': 123}, {'Retry-After': '45'})
        success = self.response(200, {'errno': 0, 'list': [
            {'fs_id': row['fs_id'], 'path': '/apps/bdpan/restore/'+row['server_filename'],
             'size': row['size'], 'dlink': url+row['server_filename']} for row in reversed(rows)
        ]})
        with patch('requests.Session') as factory, patch.object(workspace, 'baidu_access_token', return_value='test'), \
                patch.object(workspace.time, 'sleep') as sleep, patch('sys.stderr'):
            get = factory.return_value.__enter__.return_value.get
            get.side_effect = [limited, success]
            self.assertEqual(workspace.download_links(rows, 'restore'), {1: url+'first', 2: url+'second'})
            sleep.assert_called_once_with(45)
            self.assertEqual([json.loads(call.kwargs['params']['fsids']) for call in get.call_args_list],
                             [[1, 2], [1, 2]])

    def test_long_server_cooldown_is_reported_without_retries(self):
        row = {'fs_id': 1, 'server_filename': 'first', 'size': 3}
        with patch('requests.Session') as factory, patch.object(workspace, 'baidu_access_token', return_value='test'), \
                patch.object(workspace.time, 'sleep') as sleep:
            get = factory.return_value.__enter__.return_value.get
            get.return_value = self.response(406, {'errno': 20012, 'request_id': 123}, {'Retry-After': '3600'})
            with self.assertRaisesRegex(workspace.BaiduRateLimit, 'HTTP 406 / 20012.*request_id=123'):
                workspace.download_links([row], 'restore')
            sleep.assert_not_called()
            get.assert_called_once()

    def test_metadata_read_timeout_retries_without_exposing_request_url(self):
        url = 'https://pan.baidu.com/example?access_token=secret'
        with patch('requests.Session') as factory, patch.object(workspace, 'baidu_access_token', return_value='test'), \
                patch.object(workspace.time, 'sleep') as sleep, patch('sys.stderr') as diagnostics:
            get = factory.return_value.__enter__.return_value.get
            get.side_effect = [ReadTimeout(url), self.response(200, {'errno': 0, 'list': []})]
            self.assertEqual(workspace.baidu_json('file', {'method': 'list'})['list'], [])
            sleep.assert_called_once_with(30)
            self.assertNotIn('secret', str(diagnostics.write.call_args_list))

    def test_failed_batch_keeps_verified_files_and_resumes_missing_parts(self):
        payload = b'encrypted'
        checksum = hashlib.sha256(payload).hexdigest()
        rows = [{'fs_id': number, 'server_filename': f'part-{number:03}', 'size': len(payload)}
                for number in range(101)]
        checksums = {row['server_filename']: checksum for row in rows}
        requests = []
        downloads = []

        def resolve(batch, folder):
            requests.append([row['fs_id'] for row in batch])
            if len(requests) == 2:
                raise workspace.BaiduRateLimit(406, 20012, 123, 0)
            return {row['fs_id']: str(row['fs_id']) for row in batch}

        def download(row, partial, *, folder, link):
            self.assertEqual(link, str(row['fs_id']))
            downloads.append(row['fs_id'])
            partial.write_bytes(payload)

        with tempfile.TemporaryDirectory() as temp, patch.object(workspace, 'download_links', side_effect=resolve), \
                patch.object(workspace, 'download_object', side_effect=download):
            target = Path(temp)
            with self.assertRaises(workspace.BaiduRateLimit):
                workspace.fetch_verified(rows, target, 'restore', sha256s=checksums)
            self.assertEqual(len(list(target.iterdir())), 100)
            (target / 'part-004').write_bytes(b'corrupted')
            workspace.fetch_verified(rows, target, 'restore', sha256s=checksums)
            self.assertEqual(requests, [list(range(100)), [100], [4, 100]])
            self.assertEqual(sorted(downloads), sorted([*range(101), 4]))
            self.assertTrue(all(workspace.digest(file) == checksum for file in target.iterdir()))

    def test_transfer_timeout_refreshes_only_failed_signed_link(self):
        rows = [{'fs_id': 1, 'server_filename': 'first', 'size': 1},
                {'fs_id': 2, 'server_filename': 'second', 'size': 1}]
        checksums = {row['server_filename']: hashlib.sha256(b'x').hexdigest() for row in rows}
        with tempfile.TemporaryDirectory() as temp, patch.object(workspace, 'download_links') as resolve, \
                patch.object(workspace, 'download_object') as download, patch.object(workspace.time, 'sleep') as sleep, \
                patch('sys.stderr'):
            resolve.side_effect = [{1: 'old-first', 2: 'old-second'}, {2: 'new-second'}]

            def transfer(row, partial, *, folder, link):
                partial.write_bytes(b'x')
                if link == 'old-second':
                    raise workspace.BaiduTransferError('ReadTimeout')

            download.side_effect = transfer
            workspace.fetch_verified(rows, Path(temp), 'restore', sha256s=checksums)
            sleep.assert_called_once_with(15)
            self.assertEqual([call.args[0] for call in resolve.call_args_list], [rows, rows[1:]])
            self.assertEqual(sorted(file.name for file in Path(temp).iterdir()), ['first', 'second'])

    def test_legacy_duplicity_metadata_uses_authenticated_gpg_fallback(self):
        row = {'fs_id': 1, 'server_filename': 'duplicity-inc.manifest.gpg', 'size': 1, 'md5': 'different'}
        with tempfile.TemporaryDirectory() as temp, patch.object(workspace, 'download_links') as resolve, \
                patch.object(workspace.subprocess, 'run') as gpg:
            target = Path(temp)
            (target / row['server_filename']).write_bytes(b'x')
            key = target / 'key'
            gpg.return_value = subprocess.CompletedProcess([], 0, stdout=b'[GNUPG:] GOODMDC\n')
            workspace.fetch_verified([row], target, 'restore', duplicity_key=key)
            resolve.assert_not_called()
            self.assertIn(str(key), gpg.call_args.args[0])
            gpg.return_value = subprocess.CompletedProcess([], 1, stdout=b'')
            resolve.side_effect = workspace.BaiduRateLimit(406, 20012, 123, 0)
            with self.assertRaises(workspace.BaiduRateLimit):
                workspace.fetch_verified([row], target, 'restore', duplicity_key=key)
            resolve.assert_called_once_with([row], 'restore')

    @staticmethod
    def response(status, body, headers=None):
        wrapper = MagicMock()
        response = wrapper.__enter__.return_value
        response.status_code = status
        response.headers = headers or {}
        response.json.return_value = body
        return wrapper


if __name__ == '__main__':
    unittest.main()
