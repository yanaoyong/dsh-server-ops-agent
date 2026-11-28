import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('capacity', Path(__file__).resolve().parents[1]/'rehearsal/verify-capacity.py')
capacity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capacity)
T = '2024-11-22T12:42:00.833+00:00'
EVENT = 'capacity-acceptance-00000000-0000-4000-8000-000000000003'
SESSION = '00000000-0000-4000-8000-000000000004'
PROOF = {'sessionId': SESSION, 'eventId': EVENT, 'created': T, 'final': {'status':'completed'},
         'firstObservation':{'device':'18','mountpoint':capacity.MOUNT},'readOnlyAcceptanceThresholdBytes':capacity.FLOOR}


def detail(cleared=None):
    return {'sessionId':SESSION,'alerts':[{'clearedAt':cleared,'alert':{'sourceAlertId':EVENT,'firedAt':T,'labels':{
        'dsh_event_id':EVENT,'instance':'example-host','mountpoint':capacity.MOUNT,'validation':'read_only_capacity',
        'alertname':'DSHReadOnlyAcceptanceFilesystemAvailableBelow5GiB'}}}]}


def obs(available):
    return {'device':'18','availableBytes':available,'observedAt':'2024-11-23T10:00:00+00:00'}


class CloseCapacity(unittest.TestCase):
    def test_requires_real_threshold_and_pins_both_identity_fields(self):
        state={}
        def unavailable(*args): self.fail('Unexpected network operation')
        capacity.reconcile_closure(PROOF,state,obs(capacity.FLOOR-1),unavailable,unavailable,lambda s:None)
        self.assertEqual(state['status'],'waiting_for_capacity')
        reads=iter([detail(),detail('confirmed')])
        calls=[]
        def send(body):
            calls.append(body)
            return {'received':0,'stored':0,'skipped':0}
        for read,deliver in [(lambda:next(reads),send),(unavailable,unavailable)]:
            capacity.reconcile_closure(PROOF,state,obs(capacity.FLOOR),read,deliver,lambda s:None)
        self.assertEqual(len(calls),1)
        self.assertEqual((calls[0]['alerts'][0]['status'],calls[0]['alerts'][0]['fingerprint'],
                          calls[0]['alerts'][0]['startsAt']),('resolved',EVENT,T))
        self.assertEqual(state['status'],'verified')

    def test_lost_receipt_is_checked_upstream_before_any_new_delivery(self):
        state={}
        def lost(body): raise OSError('simulated')
        with self.assertRaises(OSError):
            capacity.reconcile_closure(PROOF,state,obs(capacity.FLOOR),detail,lost,lambda s:None)
        capacity.reconcile_closure(PROOF,state,obs(capacity.FLOOR-1),lambda:detail('recorded'),
                                   lambda body:self.fail('duplicated clear'),lambda s:None)
        self.assertEqual(state['attempts'],1)
        self.assertEqual(state['status'],'verified')

    def test_refuses_different_mount_or_firing(self):
        unavailable=lambda *args:self.fail('Unexpected delivery')
        changed=dict(obs(capacity.FLOOR),device='99')
        with self.assertRaises(RuntimeError):
            capacity.reconcile_closure(PROOF,{},changed,unavailable,unavailable,lambda s:None)
        other=detail()
        other['alerts'][0]['alert']['sourceAlertId']='different-firing'
        with self.assertRaises(RuntimeError):
            capacity.reconcile_closure(PROOF,{},obs(capacity.FLOOR),lambda:other,unavailable,lambda s:None)


if __name__=='__main__':
    unittest.main()
