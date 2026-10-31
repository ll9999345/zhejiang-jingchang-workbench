#!/usr/bin/env python3
"""Install a pinned, project-local Remotion runtime without changing existing deps.

Current Remotion native libraries require macOS 15. The isolated 4.0.330
runtime is retained for local acceptance on the existing macOS 13 Intel host.
Only public npm packages are fetched; lifecycle scripts are disabled.
"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
VERSION = '4.0.330'
DESTINATION = ROOT / '.runtime' / f'remotion-caption-{VERSION}'
PACKAGE = {'name': 'openmontage-isolated-caption-runtime', 'version': '1.0.0',
           'private': True, 'dependencies': {'@remotion/cli': VERSION, 'remotion': VERSION,
               'react': '18.3.1', 'react-dom': '18.3.1'}}


def main():
    npm = shutil.which('npm')
    if not npm:
        raise RuntimeError('The existing Node/npm runtime is required')
    DESTINATION.mkdir(parents=True, exist_ok=True)
    package = DESTINATION / 'package.json'
    if package.exists():
        if json.loads(package.read_text()) != PACKAGE:
            raise RuntimeError('Existing runtime metadata differs; it has not been overwritten')
    else:
        with package.open('x', encoding='utf-8') as stream:
            json.dump(PACKAGE, stream, indent=2)
    receipt_dir = ROOT / '.runtime/installation-receipts'
    receipt_dir.mkdir(parents=True, exist_ok=True)
    stem = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-caption-runtime-' + uuid.uuid4().hex[:8]
    log = receipt_dir / (stem + '.log')
    with log.open('x', encoding='utf-8') as stream:
        subprocess.run([npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund'],
                       cwd=DESTINATION, stdout=stream, stderr=subprocess.STDOUT, check=True)
    lock = DESTINATION / 'package-lock.json'
    packages = json.loads(lock.read_text())['packages']
    remotion_versions = {name: value['version'] for name, value in packages.items()
                        if name == 'node_modules/remotion' or
                        (name.startswith('node_modules/@remotion/') and name.count('/') == 2)}
    if any(version != VERSION for version in remotion_versions.values()):
        raise RuntimeError('Remotion package versions do not match; rendering was not attempted')
    receipt = {'destination': str(DESTINATION), 'source': 'https://registry.npmjs.org/',
               'version': VERSION, 'lifecycle_scripts_executed': False,
               'existing_composer_dependencies_changed': False,
               'remotion_versions': remotion_versions, 'packages': packages,
               'package_lock_sha256': hashlib.sha256(lock.read_bytes()).hexdigest(),
               'license': 'Remotion license in node_modules/remotion/LICENSE.md; not MIT',
               'render_acceptance': 'pending', 'log': str(log)}
    result = receipt_dir / (stem + '.json')
    with result.open('x', encoding='utf-8') as stream:
        json.dump(receipt, stream, indent=2)
    print('ISOLATED_CAPTION_RUNTIME_INSTALLED', result, flush=True)


if __name__ == '__main__':
    main()
