#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ -x .venv/bin/python ]; then
  exec .venv/bin/python scripts/start_workbench.py "$@"
fi
exec python3 scripts/start_workbench.py "$@"
