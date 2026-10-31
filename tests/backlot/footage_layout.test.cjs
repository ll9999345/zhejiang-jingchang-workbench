const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Locked before the MoneyPrinter four-column rewrite on 2026-09-30.
// The browser acceptance reads this literal too, keeping a single baseline.
const LEGACY_FOOTAGE_IDS = [
  "footageApp", "projectBadge", "backToModel", "stepScript", "stepMaterials", "stepExport",
  "pageMessage", "pageMessageText", "scriptHeading", "scriptStatus", "topicLabel", "proposalSummary",
  "scriptEditor", "scriptMeta", "replanButton", "shotCountLabel", "shotList", "controlsHeading",
  "actionHeading", "actionHint", "collectButton", "createButton", "renderButton", "cancelButton",
  "sourceHeading", "materialMode", "allowGeneric", "sourceCapabilities", "uploadHeading", "uploadAudioRole",
  "assetUpload", "uploadStatus", "assetSummary", "voiceHeading", "narrationMode", "voiceSelect",
  "uploadedNarration", "subtitlePath", "networkConfirmRow", "networkConfirm", "voiceStatus", "voicePreviewButton",
  "voicePreviewMode", "reuseVoicePreviewButton", "voicePreviewAudio", "advancedSettings", "aspectRatio", "resolution",
  "fps", "fit", "variants", "stopAt", "footageOrder", "transition", "transitionSeconds", "voiceRate",
  "narrationVolume", "sourceVolume", "subtitleFont", "subtitleFontSize", "subtitlePosition", "subtitleColor",
  "subtitleOutlineColor", "subtitleOutlineWidth", "subtitleEnabled", "subtitleBackground", "kenBurns", "bgmMode",
  "bgmPath", "bgmVolume", "exportSettingsButton", "importSettingsInput", "settingsImportReport", "batchSettings",
  "exportBatchTemplateButton", "importBatchInput", "batchManifest", "batchPreflightButton", "batchPreflightResults",
  "batchConfirm", "batchSubmitButton", "batchCurrent", "batchCancelButton", "batchHistory", "extendedServices",
  "extendedServicesStatus", "currentJobPanel", "jobHeading", "jobStatus", "jobProgressBar", "jobProgressValue",
  "jobMessage", "missingShots", "jobWarnings", "outputArea", "historyHeading", "historyCount", "historyList"
];

const html = fs.readFileSync(path.join(__dirname, '../../backlot/ui/footage.html'), 'utf8');
// Only structural markup is needed. Ignore script/style bodies and comments so
// their strings cannot be mistaken for elements or attributes.
const markup = html.replace(/<!--[\s\S]*?-->/g, '').replace(/(<(?:script|style)\b[^>]*>)[\s\S]*?(<\/(?:script|style)>)/gi, '$1$2');
const root = {tag: '#document', attrs: {}, children: [], parent: null};
const nodes = [];
const stack = [root];
const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
for (const match of markup.matchAll(/<(\/?)([a-z][a-z0-9-]*)(\s+(?:"[^"]*"|'[^']*'|[^'">])*)?\s*(\/?)>/gi)) {
  const [, closing, rawTag, rawAttrs = '', selfClosing] = match;
  const tag = rawTag.toLowerCase();
  if (closing) {
    const index = stack.findLastIndex(node => node.tag === tag);
    if (index > 0) {
      stack[index].end = match.index + match[0].length;
      stack.length = index;
    }
    continue;
  }
  const attrs = {};
  for (const attribute of rawAttrs.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    attrs[attribute[1].toLowerCase()] = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
  }
  const parent = stack.at(-1);
  const node = {tag, attrs, parent, children: [], start: match.index, end: match.index + match[0].length};
  parent.children.push(node); nodes.push(node);
  if (!selfClosing && !voidTags.has(tag)) stack.push(node);
}
const byId = id => nodes.find(node => node.attrs.id === id);
const hasClass = (node, name) => (node.attrs.class || '').split(/\s+/).includes(name);
const within = (node, ancestor) => !!node && (node === ancestor || within(node.parent, ancestor));
const text = node => markup.slice(node.start, node.end).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const accessibleName = node => node.attrs['aria-label'] || text(node);
const hidden = node => !!node && (Object.hasOwn(node.attrs, 'hidden') || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(node.attrs.style || '') || hidden(node.parent));

test('MoneyPrinter layout retains every previous DOM id without duplicates', () => {
  assert.equal(LEGACY_FOOTAGE_IDS.length, 98, 'The pre-rewrite baseline must stay intact');
  const ids = nodes.filter(node => node.attrs.id).map(node => node.attrs.id);
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), [], 'Duplicate DOM ids');
  assert.deepEqual(LEGACY_FOOTAGE_IDS.filter(id => !ids.includes(id)), [], 'Removed legacy DOM ids');
});

test('primary settings have four direct columns in copy, video, audio, subtitle order', () => {
  const body = nodes.find(node => node.tag === 'body');
  assert.equal(body.attrs['data-studio-layout'], 'moneyprinter');
  const main = byId('footageApp');
  assert.equal(main.tag, 'main');
  const grid = nodes.find(node => hasClass(node, 'moneyprinter-columns'));
  assert.ok(grid && within(grid, main), 'Main settings grid is missing');
  const columns = grid.children.filter(node => hasClass(node, 'moneyprinter-column'));
  assert.deepEqual(columns.map(node => node.attrs['data-settings-column']), ['copy', 'video', 'audio', 'subtitle']);
  for (const [index, label] of ['文案', '视频', '音频', '字幕'].entries()) {
    assert.match(text(columns[index]), new RegExp(label), `${label} column needs a visible heading`);
    assert.equal(hidden(columns[index]), false, `${label} column must be visible`);
  }
  assert.ok(within(byId('scriptEditor'), columns[0]), 'Script editor belongs in the copy column');
  assert.ok(within(byId('aspectRatio'), columns[1]), 'Video format belongs in the video column');
  assert.ok(within(byId('narrationMode'), columns[2]), 'Narration belongs in the audio column');
  assert.ok(within(byId('subtitleEnabled'), columns[3]), 'Subtitles belong in the subtitle column');
});

test('storyboard is initially folded while generate and cancel remain visible', () => {
  const storyboard = byId('storyboardDetails');
  assert.equal(storyboard?.tag, 'details');
  assert.equal(Object.hasOwn(storyboard.attrs, 'open'), false);
  assert.ok(within(byId('shotList'), storyboard));
  for (const id of ['createButton', 'cancelButton']) {
    const button = byId(id);
    assert.equal(button?.tag, 'button');
    assert.equal(button.attrs.type, 'button');
    assert.equal(hidden(button), false, `${id} must stay visible even while disabled`);
  }
  assert.ok(hasClass(byId('createButton'), 'primary-action'), 'Generate is the primary action');
});

test('task history and infrequent settings live in native dialogs with close and cancel controls', () => {
  for (const [id, opener, children] of [
    ['taskManagerDialog', 'openTaskManagerButton', ['historyHeading', 'historyCount', 'historyList']],
    ['settingsDialog', 'openSettingsButton', ['batchSettings', 'exportSettingsButton', 'importSettingsInput', 'extendedServices']]
  ]) {
    const dialog = byId(id);
    assert.equal(dialog?.tag, 'dialog', `${id} needs native modal semantics`);
    assert.equal(Object.hasOwn(dialog.attrs, 'open'), false, `${id} starts closed`);
    assert.equal(byId(opener)?.tag, 'button');
    assert.equal(byId(opener).attrs.type, 'button');
    for (const child of children) assert.ok(within(byId(child), dialog), `${child} belongs inside ${id}`);
    const buttons = nodes.filter(node => node.tag === 'button' && node.attrs['data-close-dialog'] === id && within(node, dialog));
    assert.ok(buttons.some(node => /关闭/.test(accessibleName(node))), `${id} needs a close button`);
    assert.ok(buttons.some(node => /取消/.test(accessibleName(node))), `${id} needs a cancel button`);
    for (const button of buttons) assert.equal(button.attrs.type, 'button', 'Dialog dismissal must not submit');
  }
});

test('the page provides explicit choose-project and new-project links', () => {
  const required = byId('projectRequired');
  assert.ok(required, 'An empty-project state is required');
  const links = nodes.filter(node => node.tag === 'a' && within(node, required));
  assert.ok(links.some(node => /选择|项目库|作品/.test(text(node)) && /^\/(?:$|library(?:[?#]|$))/.test(node.attrs.href || '')), 'Missing choose-project link');
  assert.ok(links.some(node => /新建|创建/.test(text(node)) && /^\/create(?:\/|[?#]|$)/.test(node.attrs.href || '')), 'Missing new-project link');
});
