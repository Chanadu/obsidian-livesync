import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).parent
spec = importlib.util.spec_from_file_location('save_pat', TOOLS / 'save-pat.py')
save_pat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(save_pat)


class PATCredentials(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.file = self.root / 'github.pat'
        self.secret = 'github_pat_fixture_only_123'
        self.file.write_text(self.secret + '\n')
        self.file.chmod(0o600)

    def fill(self, host='github.com', path='Chanadu/obsidian-vault.git'):
        env = dict(os.environ, LIVESYNC_BACKUP_PAT_FILE=str(self.file),
                   GIT_ASKPASS=str(TOOLS.resolve() / 'git-askpass.py'), GIT_TERMINAL_PROMPT='0',
                   GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_SYSTEM='/dev/null')
        return subprocess.run(['git', '-c', 'credential.helper=', '-c', 'credential.useHttpPath=true',
                               'credential', 'fill'],
                              input=f'protocol=https\nhost={host}\npath={path}\n\n',
                              env=env, text=True, capture_output=True, timeout=10)

    def test_actual_git_can_request_credentials_without_a_terminal(self):
        result = self.fill()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('username=Chanadu', result.stdout)
        self.assertIn('password=' + self.secret, result.stdout)
        self.assertNotIn(self.secret, result.stderr)

    def test_refuses_another_repository(self):
        result = self.fill(path='someone/other.git')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(self.secret, result.stdout + result.stderr)

    def test_refuses_a_lookalike_host(self):
        result = self.fill(host='github.com.attacker.invalid')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(self.secret, result.stdout + result.stderr)

    def test_refuses_a_world_readable_token_file(self):
        self.file.chmod(0o644)
        result = self.fill()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(self.secret, result.stdout + result.stderr)

    def test_refuses_a_symlink_to_a_token(self):
        target = self.file.with_suffix('.real')
        self.file.rename(target)
        self.file.symlink_to(target)
        result = self.fill()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(self.secret, result.stdout + result.stderr)

    def test_saves_token_privately_without_echoing_it(self):
        output = io.StringIO()
        with patch.object(Path, 'home', return_value=self.root), \
                patch.object(save_pat.getpass, 'getpass', return_value=self.secret), \
                contextlib.redirect_stdout(output):
            save_pat.main()
        saved = self.root / 'livesync-backup-state/github.pat'
        self.assertEqual(saved.read_text(), self.secret + '\n')
        self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
        self.assertEqual(saved.parent.stat().st_mode & 0o777, 0o700)
        self.assertNotIn(self.secret, output.getvalue())


if __name__ == '__main__':
    unittest.main()
