export const CHAT_AUDIO_MIME = Object.freeze(Object.assign(Object.create(null), {
  'audio/wav': 'audio/wav',
  'audio/mpeg': 'audio/mp3',
  'audio/mp3': 'audio/mp3',
  'audio/aac': 'audio/aac',
  'audio/aiff': 'audio/aiff',
  'audio/flac': 'audio/flac',
  'audio/ogg': 'audio/ogg',
  'audio/webm': 'audio/webm',
  'audio/mp4': 'audio/m4a',
  'audio/m4a': 'audio/m4a'
}));
export const CHAT_AUDIO_TYPES = Object.freeze(Object.keys(CHAT_AUDIO_MIME));
