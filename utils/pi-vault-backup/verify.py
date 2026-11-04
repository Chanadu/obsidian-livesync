#!/usr/bin/env python3
"""Reject partial exports before rsync can delete files in the Git checkout."""
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys


def excluded(name):
    return any(
        part in {'.git', '.obsidian', '.livesync', '.livesync-region-recovery', '.gitignore', '.gitattributes'}
        or part.startswith('.env')
        for part in PurePosixPath(name).parts
    )


def verify(manifest, export, repo):
    expected = {}
    for line in manifest.read_text().splitlines():
        fields = line.rsplit('\t', 3)
        if len(fields) != 4:
            raise ValueError('Invalid CLI manifest line; refusing to update Git.')
        name, size, _mtime, revision = fields
        if excluded(name):
            continue
        path = PurePosixPath(name)
        if not name or path.is_absolute() or '..' in path.parts or '\\' in name:
            raise ValueError('Unsafe filename in export manifest.')
        if revision.endswith('*'):
            raise ValueError('Snapshot contains unresolved note conflicts; refusing to choose a branch for backup.')
        if name in expected:
            raise ValueError('Duplicate filename in export manifest.')
        expected[name] = int(size)
    if not expected:
        raise ValueError('Export is empty; leaving the Git checkout untouched.')

    actual = set()
    for path in export.rglob('*'):
        name = path.relative_to(export).as_posix()
        if excluded(name):
            continue
        if path.is_symlink():
            raise ValueError('Unexpected symbolic link in export.')
        if path.is_file():
            actual.add(name)
            if name not in expected or path.stat().st_size != expected[name]:
                raise ValueError('An exported file is unexpected or has an incomplete size.')
    if actual != set(expected):
        raise ValueError(f'Export is incomplete: expected {len(expected)} files, found {len(actual)}.')

    tracked = subprocess.check_output(['git', '-C', str(repo), 'ls-files', '-z'])
    previous = {os.fsdecode(name) for name in tracked.split(b'\0') if name and not excluded(os.fsdecode(name))}
    removed = previous - actual
    threshold = max(20, len(previous) // 4)
    if len(removed) > threshold:
        raise ValueError(f'Export would remove {len(removed)} tracked files; review the snapshot manually first.')
    print(f'Verified {len(actual)} exported files; {len(removed)} old paths will be removed.')


if __name__ == '__main__':
    try:
        verify(*(Path(arg) for arg in sys.argv[1:]))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f'Backup stopped: {error}', file=sys.stderr)
        sys.exit(1)
