import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('backup_verify', Path(__file__).with_name('verify.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ExportChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.export = self.root / 'export'
        self.export.mkdir()
        self.repo = self.root / 'repo'
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        self.manifest = self.root / 'manifest.tsv'

    def snapshot(self, files):
        records = []
        for name, text in files.items():
            path = self.export / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
            records.append(f'{name}\t{len(text.encode())}\t1\t2-rev\n')
        self.manifest.write_text(''.join(records))

    def check(self):
        module.verify(self.manifest, self.export, self.repo)

    def test_valid_unicode_and_nested_notes(self):
        self.snapshot({'notes/Café.md': 'Hello 🐈', 'plain.md': 'Notes'})
        self.check()

    def test_empty_snapshot_is_rejected(self):
        self.snapshot({})
        with self.assertRaisesRegex(ValueError, 'empty'):
            self.check()

    def test_missing_file_is_rejected(self):
        self.snapshot({'a.md': 'A', 'b.md': 'B'})
        (self.export / 'b.md').unlink()
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            self.check()

    def test_truncated_file_is_rejected(self):
        self.snapshot({'a.md': 'ABC'})
        (self.export / 'a.md').write_text('A')
        with self.assertRaisesRegex(ValueError, 'incomplete size'):
            self.check()

    def test_unresolved_conflict_is_rejected(self):
        self.snapshot({'a.md': 'A'})
        self.manifest.write_text(self.manifest.read_text().replace('2-rev', '2-rev*'))
        with self.assertRaisesRegex(ValueError, 'unresolved'):
            self.check()

    def test_traversal_is_rejected(self):
        self.manifest.write_text('../outside.md\t1\t1\t2-rev\n')
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            self.check()

    def test_symlink_is_rejected(self):
        self.snapshot({'a.md': 'A'})
        (self.export / 'b.md').symlink_to(self.export / 'a.md')
        with self.assertRaisesRegex(ValueError, 'symbolic'):
            self.check()

    def test_secrets_and_plugin_state_are_excluded(self):
        self.snapshot({'a.md': 'A', '.env.local': 'secret', '.obsidian/data.json': 'secret'})
        self.check()

    def test_large_unexpected_deletion_is_rejected(self):
        for index in range(40):
            (self.repo / f'{index}.md').write_text('Old')
        subprocess.run(['git', '-C', str(self.repo), 'add', '-A'], check=True)
        self.snapshot({'a.md': 'A'})
        with self.assertRaisesRegex(ValueError, 'remove 40'):
            self.check()


if __name__ == '__main__':
    unittest.main()
