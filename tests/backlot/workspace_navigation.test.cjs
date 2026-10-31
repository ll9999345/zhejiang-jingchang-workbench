const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../backlot/ui/model.js'), 'utf8');
function fragment(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function fixture() {
  const ids = {};
  const element = id => ids[id] ||= { id, hidden: false, value: '', textContent: '', dataset: {}, classList: {toggle(){}}, setAttribute(){}, removeAttribute(){} };
  const cards = ['mediaNarrationCard', 'mediaPublishCard', 'localToolsCard', 'analysisCard'].map(element);
  const context = vm.createContext({
    workflow: {draftId: null},
    URL, window: {location:{href:'http://localhost/model'}, history:{replaceState(){}}},
    editSteps: ['mediaNarrationCard', 'mediaVideoComposeCard', 'mediaMusicCard', 'mediaAudioMixCard'],
    shell: element('shell'), entryContext: element('entryContext'), mediaPipeline: element('mediaPipeline'), qualityReviewSection: element('qualityReviewSection'),
    mediaProjectId: element('mediaProjectId'), mediaPublishVideo: element('mediaPublishVideo'),
    mediaQualitySubtitles: {checked:false}, mediaSubtitlePath: element('mediaSubtitlePath'),
    document: { getElementById: element, querySelectorAll: selector => selector === '#mediaGrid > article' ? cards : [] },
    sessionStorage: {setItem(){},getItem(){return null}}, syncProjectSelection(){}, restoreNarrationDraft(){}, refreshMediaCapabilities(){},
    loadMediaProjectState: async () => ({}), setStatus(){},
    mediaLines: field => field.value.split('\n').map(s => s.trim()).filter(Boolean),
  });
  vm.runInContext(fragment('let workspaceView =', 'const toggleAdvancedMediaButton'), context);
  vm.runInContext(fragment('function phaseToQualityStage(', 'function inferResumePhase('), context);
  vm.runInContext(fragment('function showMediaPanel(', 'function setMediaNarrationStatus('), context);
  vm.runInContext(fragment('function qualityMediaPaths()', 'async function qualityMedia()'), context);
  return {context, ids, cards, run: script => vm.runInContext(script, context)};
}
test('a handed-off brief collapses duplicate inputs while keeping them editable', () => {
  const f = fixture();
  f.ids.entryContext.dataset.compactRequest = 'true';
  f.context.document.getElementById('projectRequestDetails');
  f.ids.projectRequestDetails.open = true;
  f.run('syncWorkspaceView()');
  assert.equal(f.ids.projectRequestDetails.open, false);
  assert.match(f.ids.projectRequestSummary.textContent, /已接收创作需求/);
});
test('one-sentence director carries its prompt and settings into the workbench', () => {
  const ids = {};
  const element = id => ids[id] ||= {hidden:true, dataset:{}, value:'', textContent:'', href:'', append(){}};
  const draft = {mode:'guided',prompt:'南北湖晨雾',settings:{workflowMode:'quality',aspectRatio:'16:9',budget:'8'}};
  const context = vm.createContext({
    URLSearchParams,
    window:{location:{search:'?entry=guided&view=quality',replace(){throw Error('unexpected redirect')}}},
    projectQueryId:() => '', readEntryDraft:() => draft,
    ENTRY_MODE_CONFIG:{guided:{title:'一句话导演',badge:'已接收入口',description:'继续创作'}},
    entryContext:element('entryContext'), entryContextEyebrow:element('entryContextEyebrow'),
    entryContextTitle:element('entryContextTitle'),entryContextBadge:element('entryContextBadge'),
    entryContextDescription:element('entryContextDescription'),entryBrief:element('entryBrief'),
    entryContextNote:element('entryContextNote'),entrySourceMeta:element('entrySourceMeta'),
    entrySourcePreview:element('entrySourcePreview'),changeEntryLink:element('changeEntryLink'),
    workflowMode:element('workflowMode'),workflow:{mode:'quality'},workflowModeHint:element('workflowModeHint'),
    document:{getElementById:element},
  });
  vm.runInContext(fragment('function initEntryContext()', 'function showRestoredProjectContext('), context);
  vm.runInContext('initEntryContext()', context);
  assert.equal(ids.prompt.value, '南北湖晨雾');
  assert.equal(ids.entryBrief.textContent, '南北湖晨雾');
  assert.equal(ids.entryContext.dataset.compactRequest, 'true');
  assert.equal(ids.aspectRatio.value, '16:9');
  assert.equal(ids.maxCost.value, 8);
  context.projectQueryId = () => 'different-project';
  ids.prompt.value = '';
  vm.runInContext('initEntryContext()', context);
  assert.equal(ids.prompt.value, '', 'a stale entry draft must not replace an explicitly opened project');
});
test('restored projects open their saved stage and cannot skip an unapproved storyboard', () => {
  const f = fixture();
  assert.equal(f.run('restoredWorkspace("proposal_review", "video", 0, false, false)'), 'plan');
  assert.equal(f.run('restoredWorkspace("storyboard_review", "video", 1, true, false)'), 'storyboard');
  assert.equal(f.run('restoredWorkspace("video_parameters", "video", 2, true, true)'), 'video');
  assert.equal(f.run('restoredWorkspace("postproduction", null, 2, true, true)'), 'edit');
  assert.equal(f.run('restoredWorkspace("quality_review", null, 3, true, true)'), 'delivery');
  assert.equal(f.run('phaseToQualityStage("provider_running")'), 2);
});
test('restoring a project never exposes postproduction on the storyboard', () => {
  const f = fixture(); f.run('setWorkspaceView("storyboard"); showMediaPanel("saved-project", {loadState:true})');
  assert.equal(f.ids.mediaPipeline.hidden, true);
  assert.equal(f.ids.mediaProjectId.value, 'saved-project');
  assert.equal(f.ids.shell.dataset.workspaceView, 'storyboard');
});
test('explicit handoff opens only editing and preserves hidden tools', () => {
  const f = fixture(); f.run('showMediaPanel("saved-project", {open:true})');
  assert.equal(f.ids.mediaPipeline.hidden, false);
  assert.equal(f.ids.mediaNarrationCard.hidden, false);
  assert.equal(f.ids.mediaPublishCard.hidden, true);
  assert.equal(f.ids.localToolsCard.hidden, true);
});
test('tool picker shows one tool and delivery shows export without narration', () => {
  const f = fixture(); f.ids.workspaceToolSelect = f.context.document.getElementById('workspaceToolSelect');
  f.ids.workspaceToolSelect.value = 'localToolsCard'; f.run('setWorkspaceView("tools")');
  assert.equal(f.ids.localToolsCard.hidden, false); assert.equal(f.ids.analysisCard.hidden, true);
  f.run('setWorkspaceView("delivery")');
  assert.equal(f.ids.mediaPublishCard.hidden, false); assert.equal(f.ids.mediaNarrationCard.hidden, true);
  assert.equal(f.ids.qualityReviewSection.hidden, false);
});
test('quality check uses the selected final video rather than guessed output filenames', () => {
  const f = fixture(); f.context.document.getElementById('mediaQualityPaths');
  assert.throws(() => f.run('qualityMediaPaths()'), /请先合成视频/);
  f.ids.mediaPublishVideo.value = 'renders/final.mp4';
  assert.deepEqual(Array.from(f.run('qualityMediaPaths()')), ['renders/final.mp4']);
  f.ids.mediaQualityPaths.value = 'renders/custom.mp4\nrenders/custom.mp4';
  assert.deepEqual(Array.from(f.run('qualityMediaPaths()')), ['renders/custom.mp4']);
});
test('subtitle review includes the selected subtitle and rejects a missing file', () => {
  const f = fixture();
  f.ids.mediaPublishVideo.value = 'renders/final.mp4';
  f.context.mediaQualitySubtitles.checked = true;
  assert.throws(() => f.run('qualityMediaPaths()'), /选择字幕文件/);
  f.ids.mediaSubtitlePath.value = 'assets/narration.srt';
  assert.deepEqual(Array.from(f.run('qualityMediaPaths()')), ['renders/final.mp4', 'assets/narration.srt']);
});

test('explicit stage navigation records history; back navigation does not create another entry', () => {
  const f = fixture(); const history = [];
  f.context.workspaceNavigationRevision = 0;
  f.context.lastEstimate = null;
  f.context.exitModeFocus = () => {};
  f.context.setModeFocus = () => {};
  f.context.setQualityStage = index => f.run(`setWorkspaceView(${JSON.stringify(['plan','storyboard','video'][index])})`);
  f.context.document.querySelector = () => ({scrollIntoView(){}});
  f.context.window.history.replaceState = (state, title, url) => { history.push(['replace',state,url]); f.context.window.location.href = new URL(url,'http://localhost').href; };
  f.context.window.history.pushState = (state, title, url) => { history.push(['push',state,url]); f.context.window.location.href = new URL(url,'http://localhost').href; };
  vm.runInContext(fragment('function navigateWorkspace(', 'document.querySelectorAll(".workspace-nav [data-workspace-view]").forEach(button => {'), f.context);
  f.run('navigateWorkspace("tools")');
  assert.equal(history.filter(item=>item[0]==='push').length,1);
  assert.equal(history.find(item=>item[0]==='push')[1].studioStage,'tools');
  f.run('navigateWorkspace("edit", false)');
  assert.equal(history.filter(item=>item[0]==='push').length,1);
  const size = history.length;
  f.run('navigateWorkspace("video")');
  assert.equal(history.length,size,'an unapproved storyboard cannot add a video-stage history entry');
});

function linkedWorkspaceFixture() {
  const f = fixture();
  const music = f.context.document.getElementById('mediaMusicCard');
  const stock = f.context.document.getElementById('mediaStockCard');
  for (const card of [music, stock]) { card.scrollIntoView = () => {}; f.cards.push(card); }
  music.dataset.workspaceGroup = 'edit'; stock.dataset.workspaceGroup = 'tools';
  f.context.document.getElementById('workspaceToolSelect').options = [{value:'localToolsCard'}, {value:stock.id}];
  f.context.workspaceToolSelect = f.ids.workspaceToolSelect;
  f.context.workspaceNavigationRevision = 0;
  f.context.mediaProject = () => 'current-project';
  f.context.prepareStockPlan = () => {};
  const saved = new Map();
  f.context.sessionStorage = {setItem:(key,value) => saved.set(key,value), getItem:key => saved.get(key)};
  f.context.window.history.replaceState = (_state, _title, url) => { f.context.window.location.href = new URL(url,'http://localhost').href; };
  vm.runInContext(fragment('function selectEditStep(', 'document.querySelectorAll(".media-recommended-path a").forEach(link => link.addEventListener('), f.context);
  vm.runInContext(fragment('function openWorkspaceFragment(', '// One visible workspace at a time.'), f.context);
  return f;
}
test('a music deep link opens the actual panel and survives project asset restoration', () => {
  const f = linkedWorkspaceFixture();
  assert.equal(f.run('openWorkspaceFragment("#mediaMusicCard")'), true);
  assert.equal(f.ids.shell.dataset.workspaceView, 'edit');
  assert.equal(f.ids.mediaMusicCard.hidden, false);
  assert.equal(f.ids.mediaNarrationCard.hidden, true);
  assert.equal(new URL(f.context.window.location.href).hash, '#mediaMusicCard');
  f.run('showMediaPanel("current-project", {loadState:true})');
  assert.equal(f.ids.mediaMusicCard.hidden, false, 'loading assets cannot hide the requested music panel');
  f.run('setWorkspaceView("tools")');
  assert.equal(new URL(f.context.window.location.href).hash, '', 'a different workspace cannot retain a stale edit destination');
});
test('a tool deep link selects a hidden tool without executing it', () => {
  const f = linkedWorkspaceFixture();
  assert.equal(f.run('openWorkspaceFragment("#mediaStockCard")'), true);
  assert.equal(f.ids.shell.dataset.workspaceView, 'tools');
  assert.equal(f.ids.workspaceToolSelect.value, 'mediaStockCard');
  assert.equal(f.ids.mediaStockCard.hidden, false);
  assert.equal(f.ids.localToolsCard.hidden, true);
  assert.equal(f.run('openWorkspaceFragment("#confirmSubmit")'), false);
  assert.equal(f.run('openWorkspaceFragment("#%E0%A4%A")'), false);
});
test('an unavailable resume preference cannot prevent opening an edit panel', () => {
  const f = linkedWorkspaceFixture();
  f.context.sessionStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(f.run('openWorkspaceFragment("#mediaMusicCard")'), true);
  assert.equal(f.ids.mediaMusicCard.hidden, false);
});
