"""Run the cleanup wrapper with emulated sudo, systemd, and Docker."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class ServerCleanup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'livesync-backup-state'
        (self.state / '.livesync').mkdir(parents=True)
        (self.state / '.livesync/settings.json').write_text('{"fixture":"private"}')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.events = self.root / 'events.jsonl'
        self.env = dict(os.environ, LIVESYNC_BACKUP_HOME=str(self.root),
                        PATH=str(self.bin) + ':' + os.environ['PATH'],
                        TEST_EVENTS=str(self.events))
        self.stub('id', '''#!/usr/bin/env python3
print('1000')
''')
        self.stub('sudo', '''#!/usr/bin/env python3
import subprocess, sys
sys.exit(subprocess.run(sys.argv[1:]).returncode)
''')
        self.stub('systemctl', '''#!/usr/bin/env python3
import json, os, sys
with open(os.environ['TEST_EVENTS'], 'a') as f:
    f.write(json.dumps(['systemctl', *sys.argv[1:]]) + '\\n')
''')
        self.stub('docker', '''#!/usr/bin/env python3
import json, os, pathlib, stat, sys
args = sys.argv[1:]
with open(os.environ['TEST_EVENTS'], 'a') as f:
    f.write(json.dumps(['docker', *args]) + '\\n')
if args[0] == 'run':
    mounts = [args[i+1] for i, v in enumerate(args[:-1]) if v == '-v']
    data = pathlib.Path(next(v[:-6] for v in mounts if v.endswith(':/data')))
    settings = data / '.livesync/settings.json'
    assert settings.read_text() == '{"fixture":"private"}'
    assert stat.S_IMODE(settings.stat().st_mode) == 0o600
    assert stat.S_IMODE(data.parent.stat().st_mode) == 0o700
    assert 'forget-servers' in args and 'fetch' not in args and 'sync' not in args
    sys.exit(int(os.environ.get('TEST_CLEANUP_EXIT', '0')))
''')
        self.script = Path(__file__).with_name('cleanup-server-devices.sh')

    def stub(self, name, source):
        target = self.bin / name
        target.write_text(source)
        target.chmod(0o700)

    def run_cleanup(self, *args):
        return subprocess.run(['bash', str(self.script), *args], env=self.env,
                              capture_output=True, text=True, timeout=20)

    def recorded(self):
        return [json.loads(line) for line in self.events.read_text().splitlines()]

    def test_stops_old_job_before_preview_and_removes_temporary_credentials(self):
        result = self.run_cleanup()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        events = self.recorded()
        self.assertEqual(events[:2], [
            ['systemctl', 'disable', '--now', 'obsidian-vault-backup.timer'],
            ['systemctl', 'stop', 'obsidian-vault-backup.service'],
        ])
        self.assertNotIn('--force', events[2])
        self.assertEqual(events[-1][:3], ['docker', 'rm', '-f'])
        self.assertEqual(list((self.state / 'jobs').iterdir()), [])
        self.assertNotIn('private', self.events.read_text())

    def test_applies_only_with_explicit_force(self):
        result = self.run_cleanup('--force')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.recorded()[2][-2:], ['forget-servers', '--force'])

    def test_failed_cleanup_keeps_timer_stopped_and_removes_temporary_credentials(self):
        self.env['TEST_CLEANUP_EXIT'] = '1'
        result = self.run_cleanup('--force')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list((self.state / 'jobs').iterdir()), [])
        self.assertNotIn('enable', self.events.read_text())

    def test_does_not_overlap_a_backup(self):
        with (self.state / 'backup.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_cleanup('--force')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(event[0] == 'docker' for event in self.recorded()))


if __name__ == '__main__':
    unittest.main()
