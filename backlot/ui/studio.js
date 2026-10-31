/* Shared navigation and presentation only. Production actions stay in their
 * owning modules; the launcher never submits a generation or paid request. */
(() => {
  'use strict';
  const icons = {
    canvas: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M9 10h12"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    moon: '<path d="M20.5 13A8.7 8.7 0 0 1 11 3.5 8.8 8.8 0 1 0 20.5 13Z"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4m10 0h4M3 15h4m10 0h4"/>',
    record: '<path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-3M8 11h8m-8 5h5"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
  };
  const icon = name => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.grid}</svg>`;
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* Optional preference. */ } };
  // 暗房影院感是默认外观；只有用户显式切到浅色才覆盖。
  const initialTheme = read('backlot.theme');
  document.documentElement.dataset.theme = initialTheme === 'light' ? 'light' : 'dark';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const extraWorkspaces = new Map([['canvas', {label: '自由画布', href: '/canvas'}], ['hypit', {label: 'Hypit 工程', href: '/hypit'}]]);
  // Real workspaces use same-origin entry points and retain the current project.
  window.ZhejiangStudio = Object.freeze({registerWorkspace(item) {
    if (!item || !/^[a-z][a-z0-9-]*$/.test(item.id) || !item.label || typeof item.href !== 'string') return false;
    let url; try { url = new URL(item.href, location.origin); } catch { return false; }
    if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) return false;
    extraWorkspaces.set(item.id, {label: String(item.label), href: url.pathname + url.search});
    document.dispatchEvent(new Event('studio:extensions'));
    return true;
  }});

  function init() {
    const page = document.body.dataset.studioPage;
    if (!page) return;
    const compactLayout = document.body.dataset.studioLayout === 'moneyprinter';
    document.body.classList.add('studio-ready');
    if (compactLayout) document.body.classList.add('studio-moneyprinter');
    const params = new URLSearchParams(location.search);
    let projectId = params.get('project') || (location.pathname.startsWith('/p/') ? decodeURIComponent(location.pathname.slice(3)) : '');
    const modelHref = projectId ? `/model?project=${encodeURIComponent(projectId)}` : '/create/guided';
    const main = document.querySelector('main, body > .wrap');
    if (main) { main.id ||= 'studioMain'; main.setAttribute('tabindex', '-1'); }
    const sidebar = document.createElement('aside');
    sidebar.className = 'studio-sidebar';
    sidebar.id = 'studioSidebar';
    sidebar.innerHTML = `<a class="studio-brand" href="/" aria-label="浙江文旅，返回项目库"><span class="studio-monogram">浙</span><span>浙江文旅<small>创作工作台</small></span></a>
      <nav class="studio-global" aria-label="工作台"><a href="/" ${page === 'library' ? 'aria-current="page"' : ''}>${icon('grid')}项目库</a><a href="/create/guided" ${page === 'entry' ? 'aria-current="page"' : ''}>${icon('plus')}新建作品</a><a class="studio-footage-link" href="${projectId ? `/footage?project=${encodeURIComponent(projectId)}` : '/footage'}" ${page === 'footage' ? 'aria-current="page"' : ''}>${icon('film')}真实素材成片</a></nav>
      <div class="studio-project-nav"></div><nav class="studio-extensions" aria-label="扩展工作区"></nav>
      <div class="studio-sidebar-footer"><span class="studio-local-dot"></span>本机工作空间<small>从一个想法，到一部作品</small></div>`;
    const title = {library: '项目库', entry: '新建作品', model: '创作工作台', footage: '真实素材剪辑', board: '制作记录', canvas: '自由画布', hypit: 'Hypit 工程'}[page];
    const top = document.createElement('header');
    top.className = 'studio-topbar';
    top.innerHTML = `<button class="studio-icon-button studio-menu" type="button" aria-label="打开导航" aria-expanded="false" aria-controls="studioSidebar">${icon('menu')}</button><div class="studio-breadcrumb"><span>工作空间</span><span aria-hidden="true">/</span><b>${title}</b></div><div class="studio-top-actions"><button type="button" class="studio-search-trigger" aria-haspopup="dialog">${icon('search')}<span>查找功能</span><kbd>⌘ K</kbd></button><button type="button" class="studio-icon-button studio-theme" aria-label="切换深浅外观">${icon('sun')}</button></div>`;
    if (compactLayout) {
      // Reuse the page's real controls in a single top bar. Moving, rather than
      // cloning, preserves IDs, event handlers and the current project state.
      const pageHeader = document.querySelector('.footage-header');
      if (pageHeader) top.insertBefore(pageHeader, top.querySelector('.studio-top-actions'));
      sidebar.setAttribute('aria-label', '工作台导航');
      const close = document.createElement('button');
      close.type = 'button'; close.className = 'studio-icon-button studio-nav-close';
      close.setAttribute('aria-label', '关闭导航'); close.innerHTML = icon('close');
      sidebar.prepend(close);
    }
    const skip = document.createElement('a');
    skip.className = 'studio-skip'; skip.href = `#${main?.id || 'studioMain'}`; skip.textContent = '跳到主要内容';
    document.body.prepend(skip, sidebar, top);

    // The procedural field and its reflected light share one paused/resumed clock.
    // No frame-rate probe or automatic quality downgrade.
    // Preference affects the ambient field only, never task lifecycle feedback.
    const aurora = document.createElement('div');
    aurora.className = 'studio-aurora';
    aurora.setAttribute('aria-hidden', 'true');
    document.body.prepend(aurora);
    const motionButton = document.createElement('button');
    motionButton.type = 'button';
    motionButton.className = 'studio-icon-button studio-motion';
    motionButton.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 8c3-5 6 5 9 0s6 5 9 0M3 16c3-5 6 5 9 0s6 5 9 0"/></svg>';
    top.querySelector('.studio-top-actions').append(motionButton);
    const motionLabel = document.createElement('span');
    motionLabel.className = 'studio-motion-label';
    motionButton.append(motionLabel);
    const ambientPreference = read('backlot.ambientPaused');
    let ambientPaused = ambientPreference === 'true';
    // The earlier candidate's automatic pause was not a user preference.
    if (ambientPreference === 'auto') write('backlot.ambientPaused', 'false');
    const transparency = window.matchMedia('(prefers-reduced-transparency: reduce)');
    function syncAmbient() {
      const systemStatic = reduced.matches || transparency.matches;
      document.body.dataset.ambientMotion = ambientPaused || systemStatic || document.hidden ? 'paused' : 'running';
      aurora.dreamField?.setRunning(document.body.dataset.ambientMotion === 'running');
      motionButton.disabled = systemStatic;
      motionButton.setAttribute('aria-pressed', String(ambientPaused || systemStatic));
      const label = systemStatic ? '背景动效已随系统设置暂停' : ambientPaused ? '播放背景动效' : '暂停背景动效';
      motionButton.setAttribute('aria-label', label);
      motionButton.title = label;
      motionLabel.textContent = systemStatic ? '系统低动态' : ambientPaused ? '背景已暂停' : '背景流动';
    }
    motionButton.addEventListener('click', () => {
      ambientPaused = !ambientPaused;
      write('backlot.ambientPaused', String(ambientPaused));
      syncAmbient();
    });
    document.addEventListener('visibilitychange', syncAmbient);
    window.addEventListener('pageshow', syncAmbient);
    reduced.addEventListener('change', syncAmbient);
    transparency.addEventListener('change', syncAmbient);
    syncAmbient();
    aurora.addEventListener('dream:play-blocked', () => { ambientPaused = true; syncAmbient(); });
    const dreamScript = document.createElement('script');
    dreamScript.src = '/ui/dream-field.js';
    dreamScript.onload = () => {
      aurora.dreamField = window.StudioDreamField?.create(aurora);
      syncAmbient();
    };
    document.head.append(dreamScript);

    const contextual = sidebar.querySelector('.studio-project-nav');
    const nav = document.querySelector('.workspace-nav');
    if (page === 'model' && nav) {
      const label = document.createElement('p'); label.className = 'studio-nav-label'; label.textContent = '制作流程';
      contextual.append(label, nav);
    } else if (projectId) {
      const link = document.createElement('a'); link.className = 'studio-context-link'; link.href = modelHref;
      link.innerHTML = `${icon('arrow')}返回创作流程`; contextual.append(link);
    }
    function renderProjectLinks() {
      contextual.querySelector('.studio-project-links')?.remove();
      sidebar.querySelector('.studio-footage-link').href = projectId ? `/footage?project=${encodeURIComponent(projectId)}` : '/footage';
      if (!projectId) return;
      const links = [ ['board','record','制作记录', `/p/${encodeURIComponent(projectId)}`] ];
      const section = document.createElement('nav'); section.className = 'studio-project-links'; section.setAttribute('aria-label', '当前项目');
      for (const [type, glyph, label, href] of links) {
        const link = document.createElement('a'); link.href = href; link.innerHTML = `${icon(glyph)}${label}`;
        if (page === type) link.setAttribute('aria-current', 'page'); section.append(link);
      }
      contextual.append(section);
    }
    renderProjectLinks();
    const extensions = sidebar.querySelector('.studio-extensions');
    function renderExtensions() {
      extensions.replaceChildren();
      for (const item of extraWorkspaces.values()) {
        const a = document.createElement('a'); a.innerHTML = icon(item.href === '/canvas' ? 'canvas' : 'grid'); a.append(document.createTextNode(item.label));
        const url = new URL(item.href, location.origin); if (projectId) url.searchParams.set('project', projectId);
        a.href = url.pathname + url.search; extensions.append(a);
        if ((page === 'canvas' && item.href === '/canvas') || (page === 'hypit' && item.href === '/hypit')) a.setAttribute('aria-current', 'page');
      }
    }
    renderExtensions(); document.addEventListener('studio:extensions', renderExtensions);
    document.addEventListener('studio:project', event => {
      if (typeof event.detail?.id !== 'string' || event.detail.id === projectId) return;
      projectId = event.detail.id; renderProjectLinks(); renderExtensions();
    });
    // Keep environment refresh beside its diagnostics instead of ahead of work.
    const refresh = document.getElementById('refreshMediaCapabilities');
    const diagnostics = document.getElementById('workspaceDiagnostics');
    if (refresh && diagnostics) diagnostics.append(refresh);

    const themeButton = top.querySelector('.studio-theme');
    function updateThemeLabel() {
      const dark = document.documentElement.dataset.theme === 'dark';
      const label = dark ? '切换为浅色外观' : '切换为深色外观';
      themeButton.setAttribute('aria-label', label);
      themeButton.title = label;
      themeButton.innerHTML = icon(dark ? 'sun' : 'moon');
    }
    updateThemeLabel();
    themeButton.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next; write('backlot.theme', next); updateThemeLabel();
    });
    new MutationObserver(updateThemeLabel).observe(document.documentElement, {attributes:true, attributeFilter:['data-theme']});

    // The MoneyPrinter layout also uses a drawer on desktop, leaving the full
    // width for its four form columns. Other pages retain their existing shell.
    const menuButton = top.querySelector('.studio-menu');
    const shade = document.createElement('button'); shade.type = 'button'; shade.className = 'studio-nav-shade'; shade.setAttribute('aria-label','关闭导航'); shade.hidden = true; document.body.append(shade);
    const mobile = window.matchMedia('(max-width: 800px)');
    const drawerMode = () => compactLayout || mobile.matches;
    const closeNav = (restore = true) => {
      document.body.classList.remove('studio-nav-open'); shade.hidden = true;
      menuButton.setAttribute('aria-expanded','false'); sidebar.inert = drawerMode(); if (main) main.inert = false; top.inert = false;
      if (restore) menuButton.focus();
    };
    const syncMobile = () => { closeNav(false); sidebar.inert = drawerMode(); };
    mobile.addEventListener('change', syncMobile); syncMobile();
    menuButton.addEventListener('click', () => {
      if (document.body.classList.contains('studio-nav-open')) return closeNav();
      sidebar.inert = false; document.body.classList.add('studio-nav-open'); shade.hidden = false;
      menuButton.setAttribute('aria-expanded','true'); if (main) main.inert = true; top.inert = true; sidebar.querySelector('a').focus();
    });
    shade.addEventListener('click', () => closeNav());
    sidebar.querySelector('.studio-nav-close')?.addEventListener('click', () => closeNav());
    sidebar.addEventListener('click', e => {
      if (drawerMode() && e.target.closest('a, button') && !e.target.closest('.studio-nav-close')) closeNav(false);
    });
    document.addEventListener('keydown', e => {
      if (!document.body.classList.contains('studio-nav-open')) return;
      if (e.key === 'Escape') { e.preventDefault(); closeNav(); }
      if (e.key === 'Tab') {
        const items = [...sidebar.querySelectorAll('a[href],button:not(:disabled)')].filter(el => el.getClientRects().length);
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    const palette = document.createElement('dialog'); palette.className = 'studio-command'; palette.setAttribute('aria-label','查找功能');
    palette.innerHTML = `<div class="studio-command-search">${icon('search')}<input type="search" aria-label="搜索页面与工具" placeholder="想做什么？试试「字幕」或「素材」" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="studioCommandList"><button type="button" class="studio-icon-button" aria-label="关闭功能搜索">${icon('close')}</button></div><div id="studioCommandList" role="listbox" aria-label="功能列表"></div><footer><span>↑ ↓ 选择</span><span>↵ 打开</span><span>esc 关闭</span></footer>`;
    document.body.append(palette);
    const search = palette.querySelector('input'); const list = palette.querySelector('[role="listbox"]');
    let commands = [], matches = [], selection = 0, opener, projectCommands = [], closing = false, openAnimation = null, exitAnimation = null, closeFallback = 0;
    let projectLookup = null, destinationTarget = null, closeFocusTarget = null;
    function activateCommand(item) {
      if (!item.keepOpen) closeCommands({animate:false, restoreFocus:false});
      item.run();
    }
    function collectCommands() {
      if (destinationTarget) {
        const target = destinationTarget;
        return [
          {label:'返回功能列表',hint:'重新选择功能',keepOpen:true,run:() => {
            destinationTarget = null; search.placeholder = '想做什么？试试「字幕」或「素材」';
            commands = collectCommands(); search.value = ''; renderCommands(); search.focus();
          }},
          ...projectCommands.map(project => ({label:project.label,hint:`${target.label} · 选择项目`,run:() => {
            const url = new URL(target.href, location.origin); url.searchParams.set('project', project.projectId);
            location.assign(url.pathname + url.search + url.hash);
          }})),
          {label:'新建作品',hint:'先建立一个项目',run:() => location.assign('/create/guided')},
        ];
      }
      const items = [{label:'项目库', hint:'所有作品', run:() => location.assign('/')}, {label:'新建作品', hint:'从一句话开始', run:() => location.assign('/create/guided')}];
      items.push({label:'自由画布', hint:'节点编排、工作流与剪辑', run:() => location.assign(projectId ? `/canvas?project=${encodeURIComponent(projectId)}` : '/canvas')});
      if (compactLayout) {
        const reveal = selector => {
          const area = document.querySelector(selector);
          if (!area) return;
          window.WorkbenchInteractions?.reveal(area);
          for (let parent = area.closest('details'); parent; parent = parent.parentElement?.closest('details')) parent.open = true;
          area.scrollIntoView({behavior: reduced.matches ? 'auto' : 'smooth', block: 'center'});
          const focus = area.matches('input,select,textarea,button,summary') ? area : area.querySelector('input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled),summary');
          focus?.focus({preventScroll: true});
        };
        for (const [label, selector] of [
          ['文案设置', '[data-settings-column="copy"]'], ['视频设置', '[data-settings-column="video"]'],
          ['音频设置', '[data-settings-column="audio"]'], ['字幕设置', '[data-settings-column="subtitle"]'],
          ['旁白与字幕', '[data-settings-column="audio"]'], ['添加背景音乐', '#bgmMode'],
          ['免费素材检索', '#materialMode'], ['镜头与选片', '#storyboardDetails'],
        ]) if (document.querySelector(selector)) items.push({label, hint: '当前页面', run: () => reveal(selector)});
        for (const [label, id] of [['任务管理', 'openTaskManagerButton'], ['设置', 'openSettingsButton']]) {
          const button = document.getElementById(id);
          if (button) items.push({label, hint: '当前页面', run: () => button.click()});
        }
      }
      if (page === 'model' && !compactLayout) {
        for (const [label, group] of [['文案设置','copy'], ['视频设置','video'], ['音频设置','audio'], ['字幕设置','subtitle']]) {
          const panel = document.querySelector(`[data-settings-column="${group}"]`);
          if (panel) items.push({label, hint:'后期制作设置', run:() => {
            window.WorkbenchInteractions?.reveal(panel);
            const target = panel.querySelector('input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled),summary');
            for (let parent=target?.closest('details'); parent; parent=parent.parentElement?.closest('details')) parent.open=true;
            target?.focus({preventScroll:true}); panel.scrollIntoView({block:'start',behavior:'auto'});
          }});
        }
      }
      if (nav) {
        for (const button of nav.querySelectorAll('[data-workspace-view]')) {
          items.push({label:button.textContent.trim().replace(/^\d\s*/,''), hint:'制作流程', disabled:button.disabled, run:() => button.click()});
        }
        const select = document.getElementById('workspaceToolSelect');
        if (select) for (const option of select.options) items.push({label:option.text, hint:'工具', run:() => {
          nav.querySelector('[data-workspace-view="tools"]').click(); select.value = option.value; select.dispatchEvent(new Event('change',{bubbles:true}));
        }});
        for (const a of document.querySelectorAll('.media-recommended-path a')) items.push({label:a.textContent.trim(),hint:'后期制作',run:() => a.click()});
      } else {
        // Destinations stay useful outside the model page. A link selects a
        // panel only; execution and approval remain in its owning form.
        const destination = (workspace, fragment = '') => {
          const url = new URL('/model', location.origin);
          if (projectId) url.searchParams.set('project', projectId);
          url.searchParams.set('workspace', workspace); url.hash = fragment;
          return url.pathname + url.search + url.hash;
        };
        items.push({label:'创意与脚本',hint:'制作流程',run:() => location.assign(projectId ? destination('plan') : '/create/guided')});
        if (projectId) for (const [label, workspace] of [['分镜','storyboard'],['视频生成','video']]) {
          items.push({label,hint:'制作流程',run:() => location.assign(destination(workspace))});
        }
        const features = [
          ['旁白与字幕','edit','mediaNarrationCard'], ['剪辑与合成视频','edit','mediaVideoComposeCard'],
          ['添加背景音乐','edit','mediaMusicCard'], ['最终混音','edit','mediaAudioMixCard'],
          ['检查成片与导出','delivery','mediaQualityCard'],
          ['离线抠图、人物增强与动画','tools','localToolsCard'], ['参考视频分析','tools','mediaReferenceCard'],
          ['免费素材检索','tools','mediaStockCard'], ['本地画面分析','tools','mediaAnalysisCard'],
          ['素材片段裁剪','tools','mediaTrimCard'], ['节奏整理与画面增强','tools','mediaPostprocessCard'],
          ['分镜图 / 素材','tools','mediaImageCard'], ['分镜图转动态视频','tools','mediaStillComposeCard'],
          ['场景动画与长视频切片','tools','mediaMontageCard'],
        ];
        for (const [label, workspace, fragment] of features) {
          if (items.some(item => item.label === label)) continue;
          items.push({label,hint:projectId ? '当前项目' : '选择项目后打开',keepOpen:!projectId,run:() => {
            const href = destination(workspace, fragment);
            if (projectId) return location.assign(href);
            destinationTarget = {label,href}; search.placeholder = `选择项目，用于「${label}」`;
            commands = collectCommands(); search.value = ''; renderCommands(); search.focus();
          }});
        }
      }
      for (const a of sidebar.querySelectorAll('.studio-footage-link, .studio-project-links a, .studio-extensions a')) items.push({label:a.textContent.trim(),hint:projectId ? '当前项目' : '打开后选择项目',run:() => location.assign(a.href)});
      return items.filter(item => !item.disabled).concat(projectCommands);
    }
    function highlight() {
      [...list.children].forEach((row, index) => { if (row.getAttribute('role') === 'option') row.setAttribute('aria-selected', String(index === selection)); });
      const active = list.children[selection];
      if (active?.getAttribute('role') === 'option') { search.setAttribute('aria-activedescendant', active.id); active.scrollIntoView({block:'nearest'}); }
      else search.removeAttribute('aria-activedescendant');
    }
    function searchScore(candidate, term) {
      if (!term) return 0;
      const exact = candidate.indexOf(term);
      if (exact >= 0) return 100 + term.length * 2 - exact * .25;
      let cursor = 0, first = -1, previous = -1, gaps = 0;
      for (const character of term) {
        const found = candidate.indexOf(character, cursor);
        if (found < 0) return -Infinity;
        if (first < 0) first = found;
        if (previous >= 0) gaps += found - previous - 1;
        previous = found; cursor = found + 1;
      }
      return 36 + term.length * 1.5 - gaps * 2 - first * .35;
    }
    function renderCommands() {
      const aliases = {'配乐':'音乐', 'bgm':'音乐', '配音':'旁白', '导出视频':'导出', '搜素材':'素材'};
      const raw = search.value.toLocaleLowerCase().trim();
      const terms = raw.split(/\s+/).filter(Boolean).map(term => aliases[term] || term);
      matches = commands.map((item, order) => {
        const label = item.label.toLocaleLowerCase();
        const allText = `${item.label} ${item.hint}`.toLocaleLowerCase();
        const scores = terms.map(term => Math.max(searchScore(label, term), searchScore(allText, term) * .82));
        return {item, order, score: scores.reduce((sum, value) => sum + value, 0)};
      }).filter(result => Number.isFinite(result.score))
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .map(result => result.item);
      if (!raw && !destinationTarget) matches = matches.filter(item => item.hint !== '作品').concat(projectCommands.slice(0, 6));
      selection = 0; list.replaceChildren();
      matches.forEach((item, index) => {
        const row = document.createElement('div'); row.id = `studioCommand${index}`; row.setAttribute('role','option'); row.className = 'studio-command-row';
        const label = document.createElement('span'); label.textContent = item.label;
        const hint = document.createElement('small'); hint.textContent = item.hint; row.append(label,hint);
        row.addEventListener('pointermove', () => { if (selection !== index) { selection = index; highlight(); } });
        row.addEventListener('click', () => activateCommand(item)); list.append(row);
      });
      if (!matches.length) { const empty = document.createElement('p'); empty.className='studio-command-empty'; empty.textContent = '没有匹配的功能，换个关键词试试。'; list.append(empty); }
      highlight();
    }
    function openCommands({animate = true} = {}) {
      if (palette.open || document.querySelector('dialog[open], [aria-modal="true"]:not([hidden])')) return;
      if (document.body.classList.contains('studio-nav-open')) closeNav();
      closing = false;
      destinationTarget = null; search.placeholder = '想做什么？试试「字幕」或「素材」';
      opener = document.activeElement === document.body ? top.querySelector('.studio-search-trigger') : document.activeElement;
      commands = collectCommands(); search.value = ''; renderCommands(); palette.showModal(); search.focus();
      if (animate && !reduced.matches && window.Motion) openAnimation = window.Motion.animate(palette,{opacity:[0,1],y:[5,0],scale:[.99,1]},{duration:.18,ease:[.22,1,.36,1]});
      // Read-only local lookup. Titles are text, and destinations must remain on
      // this origin; project metadata can never inject a command or external URL.
      if (!projectLookup) projectLookup = fetch('/api/projects').then(response => {
        if (!response.ok) throw new Error('Project lookup unavailable'); return response.json();
      }).then(projects => {
        projectCommands = (Array.isArray(projects) ? projects : []).flatMap(project => {
          if (!project.project_id) return [];
          const fallback = `/model?project=${encodeURIComponent(project.project_id)}`;
          let destination; try { destination = new URL(project.resume_url || fallback, location.origin); } catch { return []; }
          if (destination.origin !== location.origin || !['/model','/footage'].includes(destination.pathname) && !destination.pathname.startsWith('/p/')) return [];
          return [{label:String(project.title || project.project_id),projectId:String(project.project_id),hint:'作品',run:() => location.assign(destination.pathname + destination.search)}];
        });
        if (palette.open) { commands = collectCommands(); renderCommands(); }
      }).catch(() => { projectLookup = null; });
    }
    function closeCommands({animate = true, restoreFocus = true} = {}) {
      if (!palette.open || closing) return;
      // A chosen command owns the next focus destination. A delayed native
      // close event must not steal focus from its field or newly opened modal.
      closeFocusTarget = restoreFocus ? opener : null;
      // Snapshot the in-flight entrance pose first, then hand animation control
      // to one native WAAPI exit. This stays reliable even if Esc is pressed
      // before the Motion entrance has finished.
      const current = getComputedStyle(palette);
      const from = {opacity: current.opacity, transform: current.transform === 'none' ? 'translateY(0px) scale(1)' : current.transform};
      try { openAnimation?.stop?.(); palette.getAnimations().forEach(animation => animation.cancel()); } catch { /* Native close below still works. */ }
      openAnimation = null;
      if (!animate || reduced.matches || !palette.animate) { closing = false; palette.close(); return; }
      closing = true;
      const finish = () => {
        if (!palette.open || !closing) return;
        closing = false; clearTimeout(closeFallback); closeFallback = 0;
        const animation = exitAnimation; exitAnimation = null; palette.close(); animation?.cancel();
      };
      try {
        exitAnimation = palette.animate([from,{opacity:0,transform:'translateY(4px) scale(.99)'}],{duration:120,easing:'cubic-bezier(.4,0,1,1)',fill:'forwards'});
        exitAnimation.onfinish = finish;
        exitAnimation.oncancel = finish;
        closeFallback = window.setTimeout(finish, 220);
      } catch { closing = false; palette.close(); }
    }
    search.addEventListener('input', renderCommands);
    search.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); if (matches.length) selection = (selection + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length; highlight();
      } else if (e.key === 'Enter') { e.preventDefault(); const item = matches[selection]; if (item) activateCommand(item); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCommands(); }
    });
    palette.querySelector('button').addEventListener('click', () => closeCommands());
    palette.addEventListener('cancel', e => { e.preventDefault(); closeCommands(); });
    palette.addEventListener('click', e => { if (e.target === palette) { const rect=palette.getBoundingClientRect(); if(e.clientY<rect.top||e.clientY>rect.bottom||e.clientX<rect.left||e.clientX>rect.right) closeCommands(); } });
    palette.addEventListener('close', () => {
      const target = closeFocusTarget; closeFocusTarget = null;
      if (palette.open) return;
      closing = false; openAnimation = null; exitAnimation = null; clearTimeout(closeFallback); closeFallback = 0;
      if (target?.isConnected && !document.querySelector('dialog[open]')) target.focus({preventScroll:true});
    });
    top.querySelector('.studio-search-trigger').addEventListener('click', openCommands);
    document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.open ? closeCommands({animate:false}) : openCommands({animate:false}); } });

    // One interruptible spring follows the real selected stage. Changing the
    // stage is immediate and never waits for a spring to finish.
    if (nav) {
      const indicator = document.createElement('i'); indicator.className = 'studio-stage-indicator'; indicator.setAttribute('aria-hidden','true'); nav.prepend(indicator);
      let lastStage = '', lastY = null, stageAnimation = null, contentAnimation = null;
      function syncStage(forceImmediate = false) {
        const selected = nav.querySelector('[aria-current="step"]'); if (!selected) return;
        const y = selected.offsetTop;
        indicator.style.height = `${selected.offsetHeight}px`;
        const stage = selected.dataset.workspaceView;
        const changed = lastStage && stage !== lastStage;
        // Start each spring at the current pose, so fast clicks reverse it
        // continuously rather than queuing motions or jumping to the old end.
        // Reapplying aria-current while loading assets is not a new selection.
        // Let the existing spring finish instead of snapping it to the end.
        if (changed || y !== lastY || forceImmediate === true) {
          stageAnimation?.stop?.(); stageAnimation = null;
          if (changed && forceImmediate !== true && !reduced.matches && window.Motion) {
            indicator.style.transition = 'none';
            stageAnimation = window.Motion.animate(indicator, {y}, {type:'spring', stiffness:470, damping:30, mass:.7});
          } else indicator.style.transform = `translateY(${y}px)`;
          lastY = y;
        }
        top.querySelector('.studio-breadcrumb b').textContent = selected.textContent.trim().replace(/^\d\s*/,'');
        if (changed && !reduced.matches && window.Motion) {
          const content = document.querySelector('.workspace-context');
          contentAnimation?.stop?.();
          contentAnimation = window.Motion.animate(content,{opacity:[.72,1],y:[2,0]},{duration:.18});
        }
        lastStage = stage;
      }
      reduced.addEventListener('change', () => {
        stageAnimation?.stop?.(); contentAnimation?.stop?.();
        const content = document.querySelector('.workspace-context');
        if (content) { content.style.opacity = '1'; content.style.transform = 'none'; }
        syncStage(true);
      });
      new MutationObserver(syncStage).observe(nav,{subtree:true,attributes:true,attributeFilter:['aria-current']});
      new ResizeObserver(syncStage).observe(nav); syncStage();
    }
    document.dispatchEvent(new Event('studio:ready'));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init,{once:true}); else init();
})();

/* Bounded contact feedback. Events and task state remain owned by the app. */
(() => {
  'use strict';
  if(window.StudioButtonFeedback)return;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'),states=new Map();
  // Semantic controls resolve at event time, so later inserted controls work
  // without registration. Legacy click targets are grounded in the six pages.
  const semantic='button,a[href],select,input[type="button"],input[type="submit"],input[type="reset"],[role="button"],[role="tab"],[role="link"],[role="option"],summary,label.upload-zone,[data-press-feedback="on"]';
  // board.js el() turns its onclick options into addEventListener calls.
  // These exact targets are audited there; .narr.tc-note has no action.
  const legacy='body[data-studio-page="board"] :is(.drawer .close,.modal-close,.script-preview,.narr:not(.tc-note),.render-meta .v)';
  const propertyActions='.thumb.approved,.wave';
  const structural='body,main,nav,aside,section,form,dialog,.studio-nav-shade,.modal-bg,[role="slider"],input[type="range"],video,audio,iframe,[data-press-feedback="off"]';
  // The canvas wrapper route does not load theme.css. Keep this component's
  // small presentation contract with its controller, scoped to this app only.
  const style=document.createElement('style');style.id='studio-button-feedback-style';style.textContent=`
    body.studio-ready[data-studio-page] [data-studio-press] { scale:var(--press-x,1) var(--press-y,1); filter:brightness(var(--press-light,1)); transform-origin:center; will-change:scale,filter; transition:background-color .16s,border-color .16s,color .16s,box-shadow .16s; }
    body.studio-ready[data-studio-page] [data-studio-press-inline] { scale:none; text-shadow:0 0 calc((var(--press-light,1) - 1)*50px) currentColor; }
    @media(prefers-reduced-motion:reduce) { body.studio-ready[data-studio-page] [data-studio-press] { scale:none!important; filter:none!important; text-shadow:none!important; will-change:auto; } }
  `;document.head.append(style);
  let frame=0;
  const busy=b=>b.matches(':disabled')||b.getAttribute('aria-disabled')==='true'||b.getAttribute('aria-busy')==='true'||!!b.closest('[inert],[hidden]');
  function buttonFor(target){
    for(let b=target instanceof Element?target:target?.parentElement;b&&b!==document.body;b=b.parentElement){
      if(b.matches(structural)){if(b.matches('video,audio')&&!b.controls)continue;return null;}
      if(b.matches(semantic)||b.matches(legacy)||(b.matches(propertyActions)&&typeof b.onclick==='function'))return b.closest('body[data-studio-page]')?b:null;
    }return null;
  }
  function keyboardTarget(e){
    // Combobox activation belongs to its selected option, not its text field.
    if(e.key==='Enter'&&e.target.getAttribute?.('aria-activedescendant'))return buttonFor(document.getElementById(e.target.getAttribute('aria-activedescendant')));
    const b=buttonFor(e.target);if(e.key===' '&&b?.matches('a[href],[role="link"]')&&!b.matches('[role="button"],[role="tab"]'))return null;return b;
  }
  function pose(s,now){const dt=Math.max(0,(now-s.time)/1000),w=s.omega,z=s.damping,wd=w*Math.sqrt(1-z*z),dx=s.x-s.target,c=(s.v+z*w*dx)/wd,e=Math.exp(-z*w*dt),co=Math.cos(wd*dt),si=Math.sin(wd*dt);return{x:s.target+e*(dx*co+c*si),v:e*(-z*w*(dx*co+c*si)+wd*(-dx*si+c*co))};}
  const axis=(now)=>({x:1,v:0,target:1,time:now,omega:30,damping:.7});
  function aim(s,target,now,omega,damping){return{...pose(s,now),target,time:now,omega,damping};}
  function reset(b){states.delete(b);b.removeAttribute('data-studio-press');b.removeAttribute('data-studio-press-inline');for(const k of ['--press-x','--press-y','--press-light'])b.style.removeProperty(k);if(!states.size){cancelAnimationFrame(frame);frame=0;}}
  function draw(now){frame=0;let moving=false;for(const[b,s]of states){if(!b.isConnected||busy(b)||reduced.matches||document.hidden){reset(b);continue;}const x=pose(s.x,now),y=pose(s.y,now);const settled=Math.abs(x.x-s.x.target)+Math.abs(y.x-s.y.target)+.02*(Math.abs(x.v)+Math.abs(y.v))<.0003;
      if(settled&&!s.held){reset(b);continue;}
      b.style.setProperty('--press-x',(settled?s.x.target:x.x).toFixed(5));b.style.setProperty('--press-y',(settled?s.y.target:y.x).toFixed(5));b.style.setProperty('--press-light',(1+Math.min(.065,Math.max(0,1-y.x)*1.15)).toFixed(4));if(!settled)moving=true;
    }if(moving)frame=requestAnimationFrame(draw);}
  function schedule(){if(!frame)frame=requestAnimationFrame(draw);}
  function press(b,input,id){if(!b||busy(b)||reduced.matches||document.hidden)return;const now=performance.now();let s=states.get(b);if(s?.held)return;
    const css=getComputedStyle(b);if(/auto|scroll/.test(css.overflowY)&&b.scrollHeight>b.clientHeight+2)return;
    const rect=b.getBoundingClientRect(),surface=rect.width>220&&rect.height>100,tab=b.matches('[role="tab"],.workspace-nav button'),icon=b.matches('.studio-icon-button,.studio-pin');
    if(css.display==='inline')b.setAttribute('data-studio-press-inline','');
    s||={x:axis(now),y:axis(now)};s.x=aim(s.x,surface?.991:tab?.982:icon?.95:.974,now,36,.84);s.y=aim(s.y,surface?.985:tab?.964:.946,now,36,.84);s.x.v=Math.min(s.x.v,surface?-.14:-.40);s.y.v=Math.min(s.y.v,surface?-.24:-.75);s.surface=surface;s.held={input,id};s.pressedAt=now;states.set(b,s);b.setAttribute('data-studio-press','');schedule();}
  function release(b,cancelled=false){const s=states.get(b);if(!s)return;if(!b.isConnected||busy(b)||reduced.matches||document.hidden)return reset(b);const now=performance.now(),quick=!cancelled&&now-s.pressedAt<85;s.held=null;s.x=aim(s.x,1,now,cancelled?34:25,cancelled?.9:.52);s.y=aim(s.y,1,now,cancelled?34:25,cancelled?.9:.52);if(quick){s.x.v=Math.min(s.x.v,s.surface?-.12:-.34);s.y.v=Math.min(s.y.v,s.surface?-.20:-.62);}schedule();}
  function pressInput(b,input,id){press(b,input,id);if(b?.matches('select'))requestAnimationFrame(()=>release(b));}
  document.addEventListener('pointerdown',e=>{if(e.button!==0||e.isPrimary===false)return;pressInput(buttonFor(e.target),'pointer',e.pointerId)},{passive:true,capture:true});
  const releasePointer=e=>{for(const[b,s]of states)if(s.held?.input==='pointer'&&s.held.id===e.pointerId)release(b,e.type!=='pointerup');};
  window.addEventListener('pointerup',releasePointer,{passive:true});window.addEventListener('pointercancel',releasePointer,{passive:true});window.addEventListener('lostpointercapture',releasePointer,{passive:true});
  document.addEventListener('pointerout',e=>{const b=buttonFor(e.target),s=states.get(b);if(s?.held?.input==='pointer'&&!b.contains(e.relatedTarget))release(b,true)},{passive:true});
  document.addEventListener('keydown',e=>{if((e.key===' '||e.key==='Enter')&&!e.repeat)pressInput(keyboardTarget(e),'key',e.key)},true);
  document.addEventListener('keyup',e=>{for(const[b,s]of states)if(s.held?.input==='key'&&s.held.id===e.key)release(b)});
  document.addEventListener('focusout',e=>{const b=buttonFor(e.target);if(b&&states.has(b))release(b,true)});
  document.addEventListener('contextmenu',()=>{for(const[b,s]of states)if(s.held)release(b,true)});
  document.addEventListener('click',e=>{if(!e.isTrusted||e.detail!==0)return;const b=buttonFor(e.target);if(b&&!states.has(b)){press(b,'assistive',0);release(b)}},{passive:true,capture:true});
  const resetAll=()=>{for(const b of states.keys())reset(b)};
  window.addEventListener('blur',resetAll);window.addEventListener('pagehide',resetAll);document.addEventListener('visibilitychange',()=>{if(document.hidden)resetAll()});reduced.addEventListener('change',resetAll);
  // Observe real state only. No timer promotes a task to success, and becoming
  // available again does not replay the previous user's press.
  new MutationObserver(()=>{for(const b of states.keys())if(!b.isConnected||busy(b))reset(b);}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled','aria-disabled','aria-busy','data-task-state','hidden']});
  window.StudioButtonFeedback=Object.freeze({stateChanged(b){if(states.has(b))release(b,true)},classify(b){if(b.matches(structural))return 'structural-or-native-scrubber';if(buttonFor(b)!==b)return 'not-action-control';if(busy(b))return 'disabled-busy-or-hidden';return reduced.matches?'reduced-motion':'covered'},inspect(){return{active:states.size,raf:!!frame,reduced:reduced.matches,held:[...states].filter(([,s])=>s.held).length}}});
})();

/* Scoped type hierarchy; all control and task behavior stays above. */
(()=>{if(document.getElementById("studio-typography-style"))return;const style=document.createElement("style");style.id="studio-typography-style";style.textContent="/* All workbench text uses the bundled, unmodified OFL WenKai Regular face. */\n@font-face {\n  font-family:\"Zhejiang WenKai\";\n  src:url(\"/ui/fonts/LXGWWenKaiLite-Regular.ttf\") format(\"truetype\");\n  font-style:normal;\n  font-weight:400;\n  font-display:swap;\n}\n:root {\n  --studio-type:\"Zhejiang WenKai\",\"PingFang SC\",sans-serif;\n  --sans:var(--studio-type);\n  --mono:var(--studio-type);\n  --screenplay:var(--studio-type);\n  --studio-editorial:var(--studio-type);\n  --studio-controls:var(--studio-type);\n}\n/* Icon fonts, if introduced, keep their own face; SVG icons are untouched. */\nbody[data-studio-page],\nbody[data-studio-page] :where(*):not(svg):not(svg *):not([data-icon-font]):not([data-icon-font] *):not(.iconfont):not(.material-icons):not(.material-symbols-outlined):not(.material-symbols-rounded):not(.material-symbols-sharp):not(.fa):not(.fas):not(.far):not(.fab):not([class^=\"fa-\"]):not([class*=\" fa-\"]) {\n  font-family:var(--studio-type)!important;\n  font-synthesis:none;\n}\nbody[data-studio-page] :is(input,textarea)::placeholder,\nbody[data-studio-page] input::file-selector-button {\n  font-family:var(--studio-type)!important;\n  font-synthesis:none;\n}\nbody[data-studio-page] :is(h1,h2,#workspaceHeading) { font-weight:400; }\nbody[data-studio-page] :is(button,input,select,textarea,option,optgroup) { font-weight:400; }\nbody[data-studio-page] :is(small,.eyebrow,.studio-nav-label,.studio-sidebar-footer,.studio-command footer,.studio-command-hint,.lib-meta,.lib-stage-link,.lib-board-link,.studio-motion-label) { font-size:12px; line-height:1.45; }\nbody[data-studio-page] :is(input[type=\"number\"],time,.cost .nums) { font-variant-numeric:tabular-nums; }\n/* Native select semantics are retained. Supported browsers render the picker\n   in the page so downloaded fonts also apply to the expanded options. */\n@supports (appearance:base-select) {\n  body[data-studio-page] select,\n  body[data-studio-page] select::picker(select) { appearance:base-select; }\n  body[data-studio-page] select::picker(select) {\n    font-family:var(--studio-type)!important;\n    font-size:14px;\n    font-weight:400;\n    line-height:1.6;\n    color:var(--t-1,#eeeaff);\n    background:var(--s-2,#201e3b);\n    border:1px solid var(--edge,#ffffff30);\n    border-radius:10px;\n    padding:5px;\n    box-shadow:0 10px 28px #0004;\n  }\n  body[data-studio-page] select option { font:400 14px/1.6 var(--studio-type); padding:4px 9px; border-radius:5px; }\n}\n";document.head.append(style)})();
