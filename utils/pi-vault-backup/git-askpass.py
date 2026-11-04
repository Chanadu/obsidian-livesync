#!/usr/bin/env python3
"""Supply the backup PAT directly to Git; never print it to the job log."""
import os
import re
import stat
import sys
from urllib.parse import urlsplit


def read_token():
    filename = os.environ.get('LIVESYNC_BACKUP_PAT_FILE')
    if not filename:
        raise ValueError('The backup PAT file is not configured.')
    with os.fdopen(os.open(filename, os.O_RDONLY | os.O_NOFOLLOW), 'r') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('The PAT must be a regular file owned by this user with mode 600.')
        token = handle.read(8192).rstrip('\r\n')
    if not re.fullmatch(r'[A-Za-z0-9_]+', token):
        raise ValueError('The PAT is empty or contains unexpected whitespace or characters.')
    return token


def answer(prompt):
    match = re.search(r"https://[^'\s]+", prompt)
    if not match:
        raise ValueError('Refusing an unexpected credential prompt.')
    target = urlsplit(match.group(0))
    if (target.hostname != 'github.com' or target.port not in (None, 443)
            or target.username not in (None, 'Chanadu')
            or target.path not in ('', '/', '/Chanadu/obsidian-vault.git')):
        raise ValueError('Refusing credentials for another host or repository.')
    if prompt.lower().startswith('username'):
        return 'Chanadu'
    if prompt.lower().startswith('password'):
        return read_token()
    raise ValueError('Refusing an unexpected credential prompt.')


if __name__ == '__main__':
    try:
        argument = sys.argv[1]
        if argument == '--check':
            read_token()
        else:
            print(answer(argument))
    except (OSError, ValueError, IndexError):
        print('Backup credential unavailable. Check the PAT file and its permissions; renew the PAT if expired.', file=sys.stderr)
        sys.exit(1)
