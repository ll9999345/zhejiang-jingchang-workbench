export const VIDEO_SAMPLING_METHOD='head-1fps-6-v1';
export const LEGACY_VIDEO_SAMPLING_METHOD='uniform-6-v1';
export function videoSamplingLabel(sample){return sample.method===LEGACY_VIDEO_SAMPLING_METHOD?'旧版全片均匀抽样':sample.fallback==='first-frame'?'逐秒抽样无画面，使用首帧':'从开头每秒1帧，最多6张';}
export const videoFrameCount=samples=>samples.reduce((n,s)=>n+s.frames.length,0);
