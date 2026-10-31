#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

# Machine-local runtime paths contain no credentials. Keep external models
# separate from the source checkout and leave existing provider settings intact.
if [ -f "$ROOT_DIR/.runtime/local-env.sh" ]; then
  . "$ROOT_DIR/.runtime/local-env.sh"
fi

# Local mode creates a random, process-only internal authorization token. The
# browser still needs the explicit two-step confirmation in model.html.
export WEB_API_LOCAL_MODE="${WEB_API_LOCAL_MODE:-1}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-4750}"

# Prefer the project's fully provisioned OpenMontage environment.  The older
# .venv-backlot environment is kept as a compatibility fallback for existing
# checkouts, but must not silently shadow newly installed core/optional tools.
if [ -x ".venv/bin/python" ]; then
  PYTHON_BIN=".venv/bin/python"
  # Keep the interpreter's sibling executables (for example Piper) visible to
  # provider discovery and child processes.  Selecting the Python binary alone
  # is not enough: capability checks resolve command dependencies through PATH.
  export PATH="$ROOT_DIR/.venv/bin:$PATH"
elif [ -x ".venv-backlot/bin/python" ]; then
  PYTHON_BIN=".venv-backlot/bin/python"
  export PATH="$ROOT_DIR/.venv-backlot/bin:$PATH"
else
  PYTHON_BIN="python3"
fi

exec "$PYTHON_BIN" -m uvicorn backlot.model_adapter:app \
  --host "$HOST" --port "$PORT" --log-level "${LOG_LEVEL:-warning}"
