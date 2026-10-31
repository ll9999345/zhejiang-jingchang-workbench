// Only help topics, never commands that install, authenticate or generate.
const topic = (command, label) => ({ command, label });
const codex = [topic('', '总览'), topic('exec', '对话运行'), topic('login', '登录说明'), topic('logout', '退出说明'), topic('doctor', '排错说明'), topic('mcp', '工具连接'), topic('app', '桌面应用'), topic('update', '更新说明')];
const gemini = [topic('', '总览'), topic('help', '帮助'), topic('mcp', '工具连接'), topic('extensions', '扩展说明')];
const antigravity = [topic('', '总览'), topic('help', '帮助'), topic('install', '安装说明'), topic('models', '模型说明'), topic('plugin', '插件说明'), topic('plugins', '插件列表说明'), topic('update', '更新说明'), topic('changelog', '版本说明')];
const jimeng = [topic('', '总览'), topic('login', '登录说明'), topic('logout', '退出说明'), topic('user_credit', '积分查询说明'), topic('text2image', '文字生图'), topic('image2image', '图片编辑'), topic('image_upscale', '图片放大'), topic('text2video', '文字生视频'), topic('image2video', '图片生视频'), topic('multimodal2video', '多素材视频'), topic('frames2video', '首尾帧视频'), topic('multiframe2video', '多帧视频'), topic('list_task', '任务列表说明'), topic('query_result', '结果查询说明')];
export function localCliHelpTopics(id, variant) {
  const items = id === 'codex' ? codex : id === 'jimeng' ? jimeng : id === 'gemini-cli' ? variant === 'antigravity' ? antigravity : gemini : [];
  return items.map(item => ({ ...item }));
}
