import {studioModelscopeReferenceLimit} from './native-modelscope-core.js';
// The pinned Infinite Canvas version distinguishes chat/image references from
// canvas LLM inputs. Share these capacities across admission and UI controls.
export const isApimartMultimodal=s=>s?.mode==='video'&&s.config?.protocol==='apimart'&&s.config.apimartReferenceMode==='multimodal';
export const IMAGE_REFERENCE_LIMIT = 20;
export const CHAT_REFERENCE_LIMIT = 20;
export const CHAT_VIDEO_LIMIT = 3;
export const CANVAS_LLM_IMAGE_LIMIT = 8;
export const CANVAS_LLM_AUDIO_LIMIT = 1;
export const CANVAS_LLM_REFERENCE_LIMIT = CANVAS_LLM_IMAGE_LIMIT + CHAT_VIDEO_LIMIT + CANVAS_LLM_AUDIO_LIMIT;
export const isArkMultimodal = studio => studio?.mode==='video' && studio?.config?.protocol==='ark' && studio.config.arkReferenceMode==='multimodal';
export const studioImageReferenceLimit = studio => studio?.config?.protocol==='jimeng'?(studio.mode==='image'?10:studio.config.jimeng?.command==='multimodal2video'?9:20): studio?.mode==='image'&&studio?.config?.protocol==='modelscope'?studioModelscopeReferenceLimit(studio):studio?.mode === 'image' && studio?.config?.protocol === 'studio' ? IMAGE_REFERENCE_LIMIT : (isArkMultimodal(studio)||isApimartMultimodal(studio))?9:4;
export const studioAudioReferenceLimit = studio => studio?.config?.protocol==='jimeng'?3: (isArkMultimodal(studio)||isApimartMultimodal(studio))?3:1;
export const studioReferenceLimit = studio => studio?.config?.protocol==='jimeng'?20: studio?.mode==='image'?IMAGE_REFERENCE_LIMIT:(isArkMultimodal(studio)||isApimartMultimodal(studio))?15:8;
