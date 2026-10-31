export const MAX_STREAM_MEDIA_BYTES=4_000_000_000;
export const MAX_BUFFERED_ASSET_BYTES=150*1024*1024;
const types=new Set(['image/png','image/jpeg','image/webp','image/gif','image/avif','image/bmp','video/mp4','video/quicktime','video/webm','video/x-flv','video/x-matroska','audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/wave','audio/ogg','audio/opus','audio/flac','audio/x-flac','audio/mp4','audio/x-m4a','audio/aac','audio/webm']);
const extensions={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',avif:'image/avif',bmp:'image/bmp',mp4:'video/mp4',m4v:'video/mp4',mov:'video/quicktime',webm:'video/webm',mkv:'video/x-matroska',flv:'video/x-flv',mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',opus:'audio/opus',flac:'audio/flac',m4a:'audio/mp4',aac:'audio/aac'};
export const streamMediaType=type=>typeof type==='string'&&types.has(type.toLowerCase().split(';')[0].trim());
export function fileMediaType(file){const type=String(file.type||'').toLowerCase();return streamMediaType(type)?type:extensions[String(file.name||'').split('.').at(-1).toLowerCase()]||type;}
export function transferSize(bytes){if(bytes>=1_000_000_000)return (bytes/1_000_000_000).toFixed(2)+' GB';if(bytes>=1024*1024)return (bytes/1024/1024).toFixed(2)+' MiB';return Math.ceil(bytes/1024)+' KiB';}
