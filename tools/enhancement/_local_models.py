"""Local-only restoration adapters using the authors' original networks.

GFPGAN's upstream inference helper catches failed inference and substitutes
the original face. Here failure is explicit, and all detection/parsing/model
paths are local. CodeFormer is loaded from the fixed source with its S-Lab
non-commercial license retained in .runtime/vendor/codeformer/LICENSE.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
WEIGHT_NAMES = {
    'RealESRGAN_x4plus': ('RealESRGAN_x4plus.pth',),
    'RealESRGAN_x4plus_anime_6B': ('RealESRGAN_x4plus_anime_6B.pth',),
    'RealESRNet_x4plus': ('RealESRNet_x4plus.pth',),
    'realesr-general-x4v3': ('realesr-general-x4v3.pth', 'realesr-general-wdn-x4v3.pth'),
    'GFPGAN': ('GFPGANv1.3.pth', 'detection_Resnet50_Final.pth', 'parsing_parsenet.pth'),
    'CodeFormer': ('codeformer.pth', 'detection_Resnet50_Final.pth', 'parsing_parsenet.pth'),
}


def model_dir() -> Path:
    return Path(os.environ.get('OPENMONTAGE_RESTORATION_MODEL_DIR', str(ROOT / '.runtime/models/restoration-20261001')))


def requirements(name: str) -> list[str]:
    from tools.local_ml_runtime import runtime_ready
    missing = []
    if name not in WEIGHT_NAMES:
        return ['未支持的本机修复模型']
    if not runtime_ready('restoration'):
        missing.append('请先安装项目内 Real-ESRGAN/GFPGAN 与兼容的 Torch 运行时')
    for filename in WEIGHT_NAMES[name]:
        if not (model_dir() / filename).is_file():
            missing.append('缺少本机权重：' + filename + '；推理时不会联网下载')
    if name == 'CodeFormer' and not all((ROOT / '.runtime/vendor/codeformer' / f).is_file()
            for f in ('codeformer_arch.py', 'vqgan_arch.py', 'LICENSE')):
        missing.append('缺少固定版本 CodeFormer 原生网络与许可文件')
    return missing


def build_upsampler(name: str, *, denoise: float = .5, tile: int = 128):
    import torch
    from basicsr.archs.rrdbnet_arch import RRDBNet
    from realesrgan import RealESRGANer
    from tools.video._shared import get_torch_device
    device = get_torch_device()
    filenames = WEIGHT_NAMES[name]
    dni = None
    if name == 'realesr-general-x4v3':
        from realesrgan.archs.srvgg_arch import SRVGGNetCompact
        network = SRVGGNetCompact(num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32,
            upscale=4, act_type='prelu')
        paths = [str(model_dir() / f) for f in filenames]
        dni = [denoise, 1 - denoise]
    else:
        network = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64,
            num_block=6 if name.endswith('_anime_6B') else 23, num_grow_ch=32, scale=4)
        paths = str(model_dir() / filenames[0])
    return RealESRGANer(scale=4, model_path=paths, model=network, dni_weight=dni,
        tile=tile, tile_pad=10, pre_pad=0, half=device == 'cuda', device=torch.device(device))


def _codeformer_class():
    from basicsr.utils.registry import ARCH_REGISTRY
    if 'CodeFormer' in ARCH_REGISTRY:
        return ARCH_REGISTRY.get('CodeFormer')
    directory = ROOT / '.runtime/vendor/codeformer'
    for name, filename in [('basicsr.archs.vqgan_arch', 'vqgan_arch.py'),
                           ('_montage_codeformer_arch', 'codeformer_arch.py')]:
        if name not in sys.modules:
            spec = importlib.util.spec_from_file_location(name, directory / filename)
            if spec is None or spec.loader is None:
                raise RuntimeError('Could not load fixed CodeFormer architecture')
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            spec.loader.exec_module(module)
    return ARCH_REGISTRY.get('CodeFormer')


class FaceRestorer:
    def __init__(self, name: str, *, upscale: int, fidelity: float = .5, background=None):
        import torch
        from facexlib.utils.face_restoration_helper import FaceRestoreHelper
        from tools.video._shared import get_torch_device
        self.name, self.fidelity, self.background = name, fidelity, background
        self.device = torch.device(get_torch_device())
        self.helper = FaceRestoreHelper(upscale, face_size=512, crop_ratio=(1, 1),
            det_model='retinaface_resnet50', save_ext='png', use_parse=True,
            device=self.device, model_rootpath=str(model_dir()))
        if name == 'CodeFormer':
            self.network = _codeformer_class()(dim_embd=512, codebook_size=1024, n_head=8,
                n_layers=9, connect_list=['32', '64', '128', '256'])
            weights = torch.load(model_dir() / 'codeformer.pth', map_location='cpu', weights_only=True)['params_ema']
        else:
            from gfpgan.archs.gfpganv1_clean_arch import GFPGANv1Clean
            self.network = GFPGANv1Clean(out_size=512, num_style_feat=512, channel_multiplier=2,
                decoder_load_path=None, fix_decoder=False, num_mlp=8, input_is_latent=True,
                different_w=True, narrow=1, sft_half=True)
            checkpoint = torch.load(model_dir() / 'GFPGANv1.3.pth', map_location='cpu', weights_only=True)
            weights = checkpoint.get('params_ema', checkpoint.get('params'))
        self.network.load_state_dict(weights, strict=True)
        self.network = self.network.eval().to(self.device)

    def enhance(self, image, *, require_faces: bool = True):
        import torch
        from basicsr.utils import img2tensor, tensor2img
        from torchvision.transforms.functional import normalize
        helper = self.helper
        helper.clean_all()
        helper.read_image(image)
        helper.get_face_landmarks_5(only_center_face=False, eye_dist_threshold=5)
        if not helper.all_landmarks_5 and require_faces:
            raise ValueError('未检测到可修复的人脸；不会把普通缩放当作人脸修复')
        if len(helper.all_landmarks_5) > 16:
            raise ValueError('人脸超过 16 张，请分批或裁剪后再修复')
        helper.align_warp_face()
        for face in helper.cropped_faces:
            tensor = img2tensor(face / 255., bgr2rgb=True, float32=True)
            normalize(tensor, (.5, .5, .5), (.5, .5, .5), inplace=True)
            tensor = tensor.unsqueeze(0).to(self.device)
            with torch.no_grad():
                if self.name == 'CodeFormer':
                    generated = self.network(tensor, w=self.fidelity, adain=True)[0]
                else:
                    generated = self.network(tensor, return_rgb=False, weight=.5)[0]
                restored = tensor2img(generated.squeeze(0), rgb2bgr=True, min_max=(-1, 1))
            helper.add_restored_face(restored.astype('uint8'))
        background = self.background.enhance(image, outscale=helper.upscale_factor)[0] if self.background else None
        helper.get_inverse_affine(None)
        output = helper.paste_faces_to_input_image(upsample_img=background)
        return output, len(helper.restored_faces)
