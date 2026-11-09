"""Check that a successful systemd exit actually produced a new backup."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class CombinedInstall(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.tools = self.root / 'tools'
        self.tools.mkdir()
        shutil.copy2(Path(__file__).with_name('install-and-cleanup.sh'), self.tools / 'install-and-cleanup.sh')
        for name in ['install-snapshot-fix.sh', 'cleanup-server-devices.sh']:
            (self.tools / name).write_text('#!/usr/bin/env bash\nexit 0\n')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        sudo = self.bin / 'sudo'
        sudo.write_text('''#!/usr/bin/env python3
import os, pathlib, sys
if sys.argv[1:3] == ['systemctl', 'start']:
    scenario = os.environ['TEST_BACKUP_SCENARIO']
    if scenario == 'failed': sys.exit(1)
    if scenario in ('new-success', 'same-content-success'):
        marker = pathlib.Path(os.environ['LIVESYNC_BACKUP_HOME']) / 'livesync-backup-state/last-success.txt'
        marker.parent.mkdir(parents=True, exist_ok=True)
        previous = marker.read_text() if marker.exists() else ''
        marker.write_text(previous if scenario == 'same-content-success' else 'new successful backup\\n')
''')
        sudo.chmod(0o700)
        self.marker = self.root / 'livesync-backup-state/last-success.txt'
        self.marker.parent.mkdir()
        self.marker.write_text('old successful backup\n')
        os.utime(self.marker, (1, 1))
        self.env = dict(os.environ, LIVESYNC_BACKUP_HOME=str(self.root),
                        PATH=str(self.bin) + ':' + os.environ['PATH'])

    def run_install(self, scenario):
        return subprocess.run(['bash', str(self.tools / 'install-and-cleanup.sh')],
                              env=dict(self.env, TEST_BACKUP_SCENARIO=scenario),
                              capture_output=True, text=True, timeout=20)

    def test_does_not_report_success_when_backup_was_skipped(self):
        result = self.run_install('skipped')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('new successful backup', result.stderr)

    def test_accepts_a_new_success_marker(self):
        result = self.run_install('new-success')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_success_marker_is_not_verified(self):
        self.marker.unlink()
        result = self.run_install('skipped')
        self.assertNotEqual(result.returncode, 0)

    def test_accepts_a_fresh_write_with_identical_timestamp_contents(self):
        result = self.run_install('same-content-success')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.marker.read_text(), 'old successful backup\n')

    def test_propagates_service_failure(self):
        result = self.run_install('failed')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('test backup failed', result.stderr)


if __name__ == '__main__':
    unittest.main()
