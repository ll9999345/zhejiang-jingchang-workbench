#!/usr/bin/env python3
"""Install fixed public WhisperX alignment sources and Chinese CPU weights.

Does not install the WhisperX ASR/diarization stack or replace any runtime.
Existing files and incomplete downloads are kept; each invocation gets a receipt.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import uuid
import zipfile

import requests

from install_montage_local_models import download, digest, ROOT

WHISPERX_REV = '771b4a14a9486f8fd5aef18ef49e35d639523dd3'
MODEL_REPO = 'jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn'
MODEL_REV = '99ccb2737be22b8bb50dcfcc39ad4d567fb90cfd'
MODEL_SHA = 'de031fd4b29e0c0667e5346450fadfe1326c89936b888b59c4ede608db763ee4'
VENDOR = ROOT / '.runtime/vendor' / f'WhisperX-{WHISPERX_REV}'
MODEL = ROOT / '.runtime/models/whisperx-align-zh-20261001'
NLTK_REV = '550b6625bcef1f2abff2ff770a5a0d272c9c6b2a'


def tokenizer():
    archive = ROOT / '.runtime/downloads' / f'punkt_tab-{NLTK_REV}.zip'
    rows = [download(f'https://raw.githubusercontent.com/nltk/nltk_data/{NLTK_REV}/packages/tokenizers/punkt_tab.zip', archive)]
    with zipfile.ZipFile(archive) as package:
        for name in ('README', 'english/abbrev_types.txt', 'english/collocations.tab',
                     'english/ortho_context.tab', 'english/sent_starters.txt'):
            destination = ROOT / '.runtime/nltk_data/tokenizers/punkt_tab' / name
            data = package.read('punkt_tab/' + name)
            if destination.exists():
                if destination.read_bytes() != data:
                    raise ValueError('Existing tokenizer differs; preserved')
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                with destination.open('xb') as stream:
                    stream.write(data)
            rows.append({'file': str(destination.relative_to(ROOT)), 'bytes': len(data),
                         'sha256': digest(destination), 'revision': NLTK_REV})
    return rows


def sources():
    return [download(f'https://raw.githubusercontent.com/m-bain/whisperX/{WHISPERX_REV}/{name}',
                     VENDOR / name) for name in (
        'LICENSE', 'whisperx/__init__.py', 'whisperx/alignment.py', 'whisperx/audio.py',
        'whisperx/utils.py', 'whisperx/schema.py', 'whisperx/log_utils.py')]


def models():
    import torch
    from safetensors.torch import load_file, save_file

    response = requests.get(f'https://huggingface.co/api/models/{MODEL_REPO}/revision/{MODEL_REV}?blobs=true', timeout=30)
    response.raise_for_status()
    metadata = response.json()
    if metadata['sha'] != MODEL_REV:
        raise ValueError('Unexpected model revision; no weights downloaded')
    entries = {row['rfilename']: row for row in metadata['siblings']}
    if entries['pytorch_model.bin'].get('lfs', {}).get('sha256') != MODEL_SHA:
        raise ValueError('Publisher model hash differs from the pinned value')
    rows = []
    for name in ('README.md', 'config.json', 'preprocessor_config.json',
                 'special_tokens_map.json', 'vocab.json', 'pytorch_model.bin'):
        row = download(f'https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REV}/{name}',
                       MODEL / name, entries[name].get('lfs', {}).get('sha256'))
        row['revision'] = MODEL_REV
        rows.append(row)
    safe = MODEL / 'model.safetensors'
    if not safe.exists():
        state = torch.load(MODEL / 'pytorch_model.bin', map_location='cpu', weights_only=True)
        if not isinstance(state, dict) or not all(isinstance(v, torch.Tensor) for v in state.values()):
            raise ValueError('Checkpoint is not a pure tensor state dictionary')
        part = safe.with_name(safe.name + '.' + uuid.uuid4().hex + '.part')
        save_file({k: v.contiguous().clone() for k, v in state.items()}, str(part), metadata={'format': 'pt'})
        del state
        if safe.exists():
            raise ValueError('Destination appeared; both files preserved')
        part.rename(safe)
    checked = load_file(safe)
    if not checked or not all(isinstance(v, torch.Tensor) for v in checked.values()):
        raise ValueError('Invalid safe tensor model; original retained')
    del checked
    rows.append({'file': str(safe.relative_to(ROOT)), 'bytes': safe.stat().st_size,
                 'sha256': digest(safe), 'source_sha256': MODEL_SHA,
                 'conversion': 'torch.load(weights_only=True) -> safetensors', 'revision': MODEL_REV})
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=['sources', 'models', 'tokenizer'], required=True)
    args = parser.parse_args()
    rows = globals()[args.phase]()
    receipt = ROOT / '.runtime/installation-receipts' / (
        datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-alignment-' + args.phase + '-' + uuid.uuid4().hex[:8] + '.json')
    receipt.parent.mkdir(parents=True, exist_ok=True)
    with receipt.open('x', encoding='utf-8') as stream:
        json.dump({'phase': args.phase, 'files': rows, 'private_media_uploaded': False,
                   'paid_calls': 0, 'scope': 'project_local'}, stream, indent=2)
    print('INSTALL_RECEIPT', receipt.relative_to(ROOT), flush=True)


if __name__ == '__main__':
    main()
