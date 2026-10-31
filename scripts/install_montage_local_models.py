#!/usr/bin/env python3
"""Install fixed public model files; no user media, account or system changes.

Run with .runtime/montage-ml/bin/python after installing the pinned packages.
Existing files are verified, never overwritten. Receipts are append-only.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tarfile
import uuid

import requests

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / '.runtime/models/restoration-20261001'
BASICSR_REV = '8d56e3a045f9fb3e1d8872f92ee4a4f07f886b0a'
CODEFORMER_REV = 'b33cc7d639d6545bfcccc7e0bc6ae51f24e79c2b'
BLIP_MODELS = {
    'blip-caption-base-20261001': ('Salesforce/blip-image-captioning-base',
        '82a37760796d32b1411fe092ab5d4e227313294b', 'pytorch_model.bin'),
    'blip-vqa-base-20261001': ('Salesforce/blip-vqa-base',
        '787b3d35d57e49572baabd22884b3d5a05acf072', 'model.safetensors'),
}
RESTORATION = {
    'RealESRGAN_x4plus.pth': 'xinntao/Real-ESRGAN/v0.1.0',
    'RealESRGAN_x4plus_anime_6B.pth': 'xinntao/Real-ESRGAN/v0.2.2.4',
    'RealESRNet_x4plus.pth': 'xinntao/Real-ESRGAN/v0.1.1',
    'RealESRGAN_x2plus.pth': 'xinntao/Real-ESRGAN/v0.2.1',
    'realesr-general-x4v3.pth': 'xinntao/Real-ESRGAN/v0.2.5.0',
    'realesr-general-wdn-x4v3.pth': 'xinntao/Real-ESRGAN/v0.2.5.0',
    'GFPGANv1.3.pth': 'TencentARC/GFPGAN/v1.3.0',
    'codeformer.pth': 'sczhou/CodeFormer/v0.1.0',
    'detection_Resnet50_Final.pth': 'xinntao/facexlib/v0.1.0',
    'parsing_parsenet.pth': 'xinntao/facexlib/v0.2.2',
}


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(2**20), b''):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, target: Path, expected: str | None = None) -> dict:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        actual = digest(target)
        if expected and actual != expected:
            raise ValueError(f'Existing {target.name} differs; preserved, no overwrite')
        print('VERIFIED_EXISTING', target.name, flush=True)
    else:
        part = target.with_name(target.name + '.' + uuid.uuid4().hex + '.part')
        print('DOWNLOAD', target.name, flush=True)
        with requests.get(url, stream=True, timeout=(20, 90)) as response:
            response.raise_for_status()
            with part.open('xb') as stream:
                for chunk in response.iter_content(2**20):
                    stream.write(chunk)
        actual = digest(part)
        if expected and actual != expected:
            raise ValueError(f'{target.name} source hash differs; partial file preserved')
        if target.exists():
            raise ValueError('Destination appeared during download; preserved both files')
        part.rename(target)
    return {'file': str(target.relative_to(ROOT)), 'source': url,
            'sha256': actual, 'bytes': target.stat().st_size,
            'source_hash_verified': bool(expected)}


def sources() -> list[dict]:
    records = []
    archive = ROOT / '.runtime/downloads' / f'BasicSR-{BASICSR_REV}.tar.gz'
    records.append(download(f'https://codeload.github.com/XPixelGroup/BasicSR/tar.gz/{BASICSR_REV}', archive))
    destination = ROOT / '.runtime/vendor' / f'BasicSR-{BASICSR_REV}'
    if not destination.exists():
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive) as package:
            for item in package.getmembers():
                if item.issym() or item.islnk() or item.isdev():
                    raise ValueError('Unexpected link/device in official source archive')
            package.extractall(destination.parent, filter='data')
    for filename in ('codeformer_arch.py', 'vqgan_arch.py'):
        records.append(download(f'https://raw.githubusercontent.com/sczhou/CodeFormer/{CODEFORMER_REV}/basicsr/archs/{filename}',
            ROOT / '.runtime/vendor/codeformer' / filename))
    records.append(download(f'https://raw.githubusercontent.com/sczhou/CodeFormer/{CODEFORMER_REV}/LICENSE',
        ROOT / '.runtime/vendor/codeformer/LICENSE'))
    return records


def restoration() -> list[dict]:
    import torch
    records = []
    for filename, release in RESTORATION.items():
        repo, version = release.rsplit('/', 1)
        row = download(f'https://github.com/{repo}/releases/download/{version}/{filename}', MODELS / filename)
        checkpoint = torch.load(MODELS / filename, map_location='cpu', weights_only=True)
        if not isinstance(checkpoint, dict) or not checkpoint:
            raise ValueError(f'{filename} has no state dictionary')
        row['weights_only_validated'] = True
        records.append(row)
        del checkpoint
    return records


def vision() -> list[dict]:
    from safetensors.torch import save_file
    import torch
    records = []
    for folder, (repo, revision, weights) in BLIP_MODELS.items():
        metadata = requests.get(f'https://huggingface.co/api/models/{repo}/revision/{revision}?blobs=true', timeout=30)
        metadata.raise_for_status()
        entries = {row['rfilename']: row for row in metadata.json()['siblings']}
        directory = ROOT / '.runtime/models' / folder
        files = ['README.md', 'config.json', 'preprocessor_config.json', 'special_tokens_map.json',
                 'tokenizer.json', 'tokenizer_config.json', 'vocab.txt', weights]
        for name in files:
            expected = entries[name].get('lfs', {}).get('sha256')
            row = download(f'https://huggingface.co/{repo}/resolve/{revision}/{name}', directory / name, expected)
            row['revision'] = revision
            records.append(row)
        if weights.endswith('.bin'):
            destination = directory / 'model.safetensors'
            if not destination.exists():
                data = torch.load(directory / weights, map_location='cpu', weights_only=True)
                if not isinstance(data, dict) or not all(isinstance(v, torch.Tensor) for v in data.values()):
                    raise ValueError('Caption checkpoint is not a pure tensor state dictionary')
                # Clone shared storages once at install time; runtime only reads safetensors.
                save_file({k: v.contiguous().clone() for k, v in data.items()}, str(destination), metadata={'format': 'pt'})
                del data
            records.append({'file': str(destination.relative_to(ROOT)), 'sha256': digest(destination),
                'bytes': destination.stat().st_size, 'conversion': 'torch.load(weights_only=True) -> safetensors',
                'source_sha256': digest(directory / weights), 'revision': revision})
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=['sources', 'restoration', 'vision'], required=True)
    args = parser.parse_args()
    records = globals()[args.phase]()
    receipt = ROOT / '.runtime/installation-receipts' / (
        datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + args.phase + '-' + uuid.uuid4().hex[:8] + '.json')
    receipt.parent.mkdir(parents=True, exist_ok=True)
    with receipt.open('x', encoding='utf-8') as stream:
        json.dump({'phase': args.phase, 'files': records, 'private_media_uploaded': False,
            'paid_calls': 0, 'scope': 'project_local'}, stream, indent=2)
    print('INSTALL_RECEIPT', receipt.relative_to(ROOT), flush=True)


if __name__ == '__main__':
    main()
