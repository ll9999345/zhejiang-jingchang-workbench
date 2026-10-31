"""Local caption-only render workspace; never mutates the main composer."""
from __future__ import annotations

import hashlib
import json
import platform
from pathlib import Path
import shutil
import uuid

ROOT = Path(__file__).resolve().parents[2]
COMPAT_VERSION = '4.0.330'
COMPAT_ROOT = ROOT / '.runtime' / f'remotion-caption-{COMPAT_VERSION}'


def runtime_for(source_root: Path) -> Path:
    """Avoid loading macOS-15-only native dylibs on the existing older host."""
    if platform.system() == 'Darwin' and int(platform.mac_ver()[0].split('.')[0] or 0) < 15:
        runtime = COMPAT_ROOT
        if not (runtime / 'node_modules/@remotion/cli/remotion-cli.js').is_file():
            raise ValueError('本机系统须安装项目内兼容字幕运行时；原有 Remotion 依赖未修改')
        package = json.loads((runtime / 'node_modules/remotion/package.json').read_text())
        if package['version'] != COMPAT_VERSION:
            raise ValueError('兼容字幕运行时版本不符，没有联网下载或替换依赖')
        return runtime
    return source_root


def prepare_workspace(source_root: Path, output_parent: Path, width: int, height: int,
                      total_frames: int) -> tuple[Path, Path, dict]:
    runtime = runtime_for(source_root)
    workspace = output_parent / ('caption-project-' + uuid.uuid4().hex[:12])
    workspace.mkdir(parents=True, exist_ok=False)
    shutil.copytree(source_root / 'src', workspace / 'src')
    shutil.copyfile(runtime / 'package.json', workspace / 'package.json')
    if (source_root / 'tsconfig.json').is_file():
        shutil.copyfile(source_root / 'tsconfig.json', workspace / 'tsconfig.json')
    else:
        (workspace / 'tsconfig.json').write_text(json.dumps({'compilerOptions': {
            'target': 'ES2020', 'module': 'ESNext', 'moduleResolution': 'bundler',
            'jsx': 'react-jsx', 'esModuleInterop': True, 'skipLibCheck': True},
            'include': ['src']}), encoding='utf-8')
    # Resolve installed dependencies explicitly instead of putting a symlink
    # into user-downloadable outputs. The native artifact collector correctly
    # rejects links that could escape the run directory.
    modules = str(runtime / 'node_modules')
    config_api = str(runtime / 'node_modules/@remotion/cli/dist/config/index.js')
    config = workspace / 'remotion.config.cjs'
    config.write_text('const {Config} = require(' + json.dumps(config_api) + ');\n' +
        'Config.overrideWebpackConfig(c => ({...c, resolve: {...c.resolve, ' +
        'modules: [' + json.dumps(modules) + ', ...(c.resolve.modules || [])]}, ' +
        'resolveLoader: {...c.resolveLoader, modules: [' + json.dumps(modules) +
        ', ...(c.resolveLoader?.modules || [])]}}));\n', encoding='utf-8')
    entry = workspace / 'src/caption-entry.tsx'
    # Import only the actual caption/video/overlay components. The full Root
    # eagerly imports Google Font modules, which would fetch fonts unnecessarily.
    entry.write_text('''import {Composition, registerRoot} from "remotion";
import {TalkingHead} from "./TalkingHead";
const Root = () => <Composition id="TalkingHead" component={TalkingHead}
    durationInFrames={DURATION} fps={30} width={WIDTH} height={HEIGHT}
    defaultProps={{videoSrc: "", captions: []}} />;
registerRoot(Root);
'''.replace('DURATION', str(total_frames)).replace('WIDTH', str(width)).replace('HEIGHT', str(height)),
                     encoding='utf-8')
    version = json.loads((runtime / 'node_modules/remotion/package.json').read_text())['version']
    record = {'runtime_version': version, 'runtime': str(runtime),
              'caption_source_sha256': hashlib.sha256((source_root / 'src/components/CaptionOverlay.tsx').read_bytes()).hexdigest(),
              'talking_head_source_sha256': hashlib.sha256((source_root / 'src/TalkingHead.tsx').read_bytes()).hexdigest(),
              'workspace': str(workspace), 'entrypoint': str(entry),
              'font_downloads_requested': False, 'main_composer_mutated': False}
    with (workspace / 'runtime.json').open('x', encoding='utf-8') as stream:
        json.dump(record, stream, ensure_ascii=False, indent=2)
    return workspace, runtime, record
