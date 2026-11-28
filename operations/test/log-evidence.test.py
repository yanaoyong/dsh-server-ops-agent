import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('log_evidence', Path(__file__).resolve().parents[1] / 'log-evidence.py')
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class LogEvidence(unittest.TestCase):
    def test_boundaries_time_distribution_and_ban_attribution(self):
        def row(second, ip):
            return json.dumps({'__REALTIME_TIMESTAMP': str(second * 1000000),
                'MESSAGE': 'Failed password for invalid user demo from ' + ip + ' port 44321 ssh2'})

        observed = evidence.ssh_failures([row(59, '192.0.2.8'), row(60, '192.0.2.8'),
            row(120, '2001:db8::2'), row(121, '192.0.2.8'), row(360, '192.0.2.8')],
            60, 360, True, {'192.0.2.8'})
        self.assertEqual(observed['minute_failures'], [1, 2, 0, 0, 0])
        self.assertEqual(observed['observed_failures'], 3)
        self.assertEqual(observed['top'][0], ['192.0.2.8', 2, {
            'by_minute': [1, 1, 0, 0, 0], 'in_existing_ban_list': True}])
        self.assertFalse(observed['top'][1][2]['in_existing_ban_list'])
        partial = evidence.ssh_failures([row(60, '192.0.2.8'), 'malformed'], 60, 360, True)
        self.assertFalse(partial['window_complete'])
        self.assertEqual(partial['observed_failures'], 1)

    def test_access_rate_requires_observed_access_records(self):
        def access(code):
            return json.dumps({'logger': 'http.log.access.log0', 'request': {'uri': '/private'}, 'status': code})

        records = [access(200), access(401), access(502), '{"logger":"http.log.error"}']
        facts = evidence.proxy_access(records, 60, 360, True)
        self.assertEqual((facts['access_records'], facts['client_errors'], facts['server_errors']), (3, 1, 1))
        self.assertEqual(facts['observed_5xx_pct'], 33.33)
        self.assertNotIn('/private', str(facts))
        self.assertIsNone(evidence.proxy_access([], 60, 360, True)['observed_5xx_pct'])
        self.assertIsNone(evidence.proxy_access(records, 60, 360, False)['observed_5xx_pct'])


if __name__ == '__main__':
    unittest.main()
