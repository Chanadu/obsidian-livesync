"""Exercise the real backup script, Git, and rsync; emulate Docker and SSH transport."""
import os
import fcntl
from pathlib import Path
import subprocess
import tempfile
import unittest


class BackupJob(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'obsidian-vault-backup'
        self.remote = self.root / 'remote.git'
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.env = dict(os.environ, LIVESYNC_BACKUP_HOME=str(self.root),
                        PATH=str(self.bin) + ':' + os.environ['PATH'], TEST_REMOTE=str(self.remote),
                        GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_SYSTEM='/dev/null')
        subprocess.run(['git', 'init', '-q', '--bare', str(self.remote)], check=True, env=self.env)
        subprocess.run(['git', 'init', '-q', '-b', 'main', str(self.repo)], check=True, env=self.env)
        (self.repo / 'a.md').write_text('old')
        (self.repo / 'b.md').write_text('retired')
        self.git('add', '-A')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Initial')
        self.git('remote', 'add', 'origin', str(self.remote))
        self.git('push', '-qu', 'origin', 'main')
        self.git('remote', 'set-url', 'origin', 'git@github.com:Chanadu/obsidian-vault.git')
        settings = self.root / 'livesync-backup-state/.livesync/settings.json'
        settings.parent.mkdir(parents=True)
        settings.write_text('{}')
        key = self.root / '.ssh/obsidian-vault-backup'
        key.parent.mkdir()
        key.write_text('test transport only')
        self.stub('ssh', '''#!/usr/bin/env python3
import os, subprocess, sys
operation = sys.argv[-1].split()[0]
if operation not in ('git-upload-pack', 'git-receive-pack'):
    sys.exit(2)
if operation == 'git-receive-pack' and os.environ.get('TEST_FAIL_PUSH') == '1':
    sys.exit(1)
sys.exit(subprocess.run([operation, os.environ['TEST_REMOTE']]).returncode)
''')
        self.stub('docker', '''#!/usr/bin/env python3
import os, pathlib, sys
args = sys.argv[1:]
if args[0] == 'rm':
    sys.exit(0)
mounts = [args[i+1] for i, value in enumerate(args[:-1]) if value == '-v']
export = pathlib.Path(next(value[:-8] for value in mounts if value.endswith(':/export')))
scenario = os.environ.get('TEST_SCENARIO', 'ok')
if 'fetch' in args:
    if scenario == 'failed':
        sys.exit(1)
    (export / 'a.md').write_text('new')
    if scenario != 'partial':
        (export / 'c.md').write_text('added')
elif args[-1] == 'ls':
    print('a.md\\t3\\t1\\t2-rev')
    print('c.md\\t5\\t1\\t2-rev')
else:
    sys.exit(2)
''')
        self.script = Path(__file__).with_name('backup.sh')

    def stub(self, name, source):
        file = self.bin / name
        file.write_text(source)
        file.chmod(0o700)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], env=self.env, stderr=subprocess.PIPE)

    def run_job(self, scenario='ok'):
        return subprocess.run(['bash', str(self.script)], env=dict(self.env, TEST_SCENARIO=scenario),
                              capture_output=True, text=True, timeout=20)

    def test_exports_commits_and_pushes_with_real_git(self):
        result = self.run_job()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.repo / 'a.md').read_text(), 'new')
        self.assertFalse((self.repo / 'b.md').exists())
        self.assertEqual(self.git('status', '--porcelain'), b'')
        head = self.git('rev-parse', 'HEAD').strip()
        remote_head = subprocess.check_output(['git', '--git-dir', str(self.remote), 'rev-parse', 'refs/heads/main'], env=self.env).strip()
        self.assertEqual(head, remote_head)
        self.assertTrue((self.root / 'livesync-backup-state/last-success.txt').is_file())
        self.assertEqual(list((self.root / 'livesync-backup-state/jobs').iterdir()), [])
        again = self.run_job()
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), head)

    def test_failed_export_never_changes_checkout(self):
        result = self.run_job('failed')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.repo / 'a.md').read_text(), 'old')
        self.assertTrue((self.repo / 'b.md').exists())
        self.assertEqual(self.git('status', '--porcelain'), b'')

    def test_partial_success_is_rejected_before_rsync(self):
        result = self.run_job('partial')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('incomplete', result.stderr)
        self.assertEqual((self.repo / 'a.md').read_text(), 'old')
        self.assertTrue((self.repo / 'b.md').exists())

    def test_dirty_checkout_is_not_modified(self):
        (self.repo / 'a.md').write_text('manual edit')
        result = self.run_job()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('uncommitted', result.stderr)
        self.assertEqual((self.repo / 'a.md').read_text(), 'manual edit')

    def test_failed_push_is_retried_without_an_extra_commit(self):
        self.env['TEST_FAIL_PUSH'] = '1'
        first = self.run_job()
        self.assertNotEqual(first.returncode, 0)
        head = self.git('rev-parse', 'HEAD')
        self.assertEqual(self.git('status', '--porcelain'), b'')
        self.assertFalse((self.root / 'livesync-backup-state/last-success.txt').exists())
        del self.env['TEST_FAIL_PUSH']
        again = self.run_job()
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertEqual(self.git('rev-parse', 'HEAD'), head)
        self.assertTrue((self.root / 'livesync-backup-state/last-success.txt').exists())

    def test_overlapping_job_is_skipped(self):
        lock = self.root / 'livesync-backup-state/backup.lock'
        with lock.open('w') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_job()
        self.assertEqual(result.returncode, 0)
        self.assertIn('Another vault backup', result.stdout)
        self.assertEqual((self.repo / 'a.md').read_text(), 'old')


if __name__ == '__main__':
    unittest.main()
