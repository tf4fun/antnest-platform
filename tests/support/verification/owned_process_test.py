"""Process permission errors need independent evidence of a departed group."""
import signal
import subprocess
import unittest
from unittest.mock import Mock, patch

from owned_process import OwnedProcess


class OwnedProcessProbeTests(unittest.TestCase):
    def owner(self, status=0):
        owner=OwnedProcess(['fixture'],grace_seconds=0.1)
        owner.child=Mock(pid=12345)
        owner.child.poll.return_value=status
        return owner

    def test_denied_probe_accepts_only_a_confirmed_empty_exited_group(self):
        for status,table,expected in [
            (0,{},False),
            (0,{12346:dict(parent=1,group=12345,state='Z')},False),
            (0,{12346:dict(parent=1,group=12345,state='S')},True),
            (None,{},True),
        ]:
            with self.subTest(status=status,table=table):
                owner=self.owner(status)
                with patch('owned_process.os.killpg',side_effect=PermissionError('probe denied')),patch('owned_process.process_table',return_value=table):
                    self.assertEqual(owner._group_alive(),expected)

    def test_denied_probe_and_failed_process_table_remain_unconfirmed(self):
        owner=self.owner()
        for error in [OSError('ps denied'),subprocess.TimeoutExpired(['ps'],15)]:
            with self.subTest(error=error),patch('owned_process.os.killpg',side_effect=PermissionError('probe denied')),patch('owned_process.process_table',side_effect=error):
                self.assertTrue(owner._group_alive())

    def test_denied_signal_is_ignored_only_for_a_confirmed_departed_group(self):
        for signum in [signal.SIGTERM,signal.SIGKILL]:
            for case in ['empty','alive','unknown','child-alive']:
                with self.subTest(signal=signum,case=case):
                    owner=self.owner(None if case=='child-alive' else 0)
                    error=PermissionError('signal denied')
                    table={12346:dict(parent=1,group=12345,state='S')} if case=='alive' else {}
                    with patch('owned_process.os.killpg',side_effect=error),patch('owned_process.process_table',side_effect=OSError('ps denied') if case=='unknown' else None,return_value=table):
                        if case=='empty': self.assertFalse(owner.signal_group(signum))
                        else:
                            with self.assertRaises(PermissionError) as raised: owner.signal_group(signum)
                            self.assertIs(raised.exception,error)


if __name__=='__main__': unittest.main()
