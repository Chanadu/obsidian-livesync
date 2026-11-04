#!/usr/bin/env python3
"""Save a PAT outside the Vault without echoing it or placing it in history."""
import getpass
import os
from pathlib import Path
import re
import tempfile


def main():
    folder = Path.home() / 'livesync-backup-state'
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    folder.chmod(0o700)
    token = getpass.getpass('Paste GitHub PAT (hidden), then press Enter: ')
    if not re.fullmatch(r'[A-Za-z0-9_]+', token):
        raise SystemExit('Token is empty or contains unexpected whitespace or characters; nothing was saved.')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=folder, prefix='.pat-', delete=False) as handle:
            temporary = Path(handle.name)
            os.chmod(handle.name, 0o600)
            handle.write(token + '\n')
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(folder / 'github.pat')
        print('PAT saved privately outside the Vault and Git checkout.')
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
