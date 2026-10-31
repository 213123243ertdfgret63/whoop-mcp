#!/bin/sh
# Stands in for /usr/bin/security in tests (see preload.ts): refuses every command.
echo "tests may not use the real keychain" >&2
exit 1
