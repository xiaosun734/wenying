const app = document.querySelector('#app');
const toastRoot = document.querySelector('#toast-root');

const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3.5 7.5h17v10.25a1.75 1.75 0 0 1-1.75 1.75H5.25a1.75 1.75 0 0 1-1.75-1.75V6.25A1.75 1.75 0 0 1 5.25 4.5h5l2 3h8.25a1.75 1.75 0 0 1 1.75 1.75"/>',
  crown: '<path d="m4 8 3.3 3.2L12 5l4.7 6.2L20 8l-1.2 10H5.2L4 8Z"/><path d="M5 20h14"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.45 2.45 0 1 1 4.27 1.63c-.84.88-1.97 1.23-1.97 2.62M12 16.7h.01"/>',
  bell: '<path d="M18 9.5a6 6 0 0 0-12 0c0 7-2.5 7-2.5 8.5h17C20.5 16.5 18 16.5 18 9.5ZM10 21h4"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m16 16 4.6 4.6"/>',
  chevron: '<path d="m7 9 5 5 5-5"/>',
  arrow: '<path d="M5 12h13M13 6l6 6-6 6"/>',
  back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  clock: '<circle cx="12" cy="12" r="8.7"/><path d="M12 7.7v4.9l3.1 1.8"/>',
  play: '<path d="m9 6 9 6-9 6V6Z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
  edit: '<path d="m4 16.5-.8 4.3 4.3-.8L19 8.5a2.5 2.5 0 0 0-3.5-3.5L4 16.5Z"/><path d="m13.5 6.5 4 4"/>',
  wand: '<path d="m15 4 5 5M5.5 18.5l10-10M5 4v3M3.5 5.5h3M19 16v3M17.5 17.5h3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  check: '<path d="m5 12 4.3 4.3L19 6.7"/>',
  spark: '<path d="m12 3 1.35 5.65L19 10l-5.65 1.35L12 17l-1.35-5.65L5 10l5.65-1.35L12 3ZM19 16l.55 2.45L22 19l-2.45.55L19 22l-.55-2.45L16 19l2.45-.55L19 16Z"/>',
  download: '<path d="M12 3v11M7.5 10.5 12 15l4.5-4.5M4 19.5h16"/>',
  close: '<path d="m7 7 10 10M17 7 7 17"/>',
  volume: '<path d="M4 10v4h3l4 3V7l-4 3H4ZM15 9.5a3.5 3.5 0 0 1 0 5M17.5 7a7 7 0 0 1 0 10"/>',
  dots: '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.7-3L3 11M3 5v6h6M4 13a8 8 0 0 0 14.7 3L21 13m0 6v-6h-6"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  chevronRight: '<path d="m9 5 7 7-7 7"/>',
  external: '<path d="M14 5h5v5M19 5l-8 8"/><path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};

function icon(name, size = 17, stroke = 1.8) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.spark}</svg>`;
}

const sourceText = `深夜十一点，沈砚在废弃的地铁站醒来。
他记得自己正在参加一场葬礼，却想不起死者是谁。站台的电子屏反复闪烁着同一个时间：23:17。远处传来列车进站的轰鸣，广播里却没有报站名，只有一个沙哑的女声在一遍遍叫他的名字。

沈砚拿出手机，屏幕上多了一张陌生的照片。照片里是三年前的自己，身边站着一个看不清脸的女孩。照片背面写着一句话：不要让她上车。

列车停在他面前时，车门缓缓打开。车厢里空无一人，唯独最后一排亮着一盏灯。那盏灯下，女孩抬起头，露出和照片里一模一样的侧脸。她对沈砚说，第一班车已经错过了，而他只有十分钟可以活着离开这里。

沈砚转身就跑，可身后的站台不知何时变成了一条没有尽头的隧道。手机再次亮起，新的照片正在自动生成——照片里，他已经坐在了女孩身边。

他猛地停下脚步，隧道里的灯一盏接一盏熄灭。最后一盏灯下，墙面浮出一行新鲜的血字：如果听见身后的脚步声，千万不要回头。可脚步声已经贴在了他的耳边，女孩的声音也从黑暗里传来，她说自己等这一天已经等了三年。

沈砚攥紧那张照片，终于想起葬礼上没有死者，只有一个失踪的人。那个人不是女孩，而是三年前为了救她，独自走进地铁隧道的自己。就在这时，列车再次进站，车门里传来一个熟悉的声音：这一次，换你留下。`;

const state = {
  view: 'dashboard',
  sourceText,
  title: '夜行者',
  genre: '悬疑',
  copyrightConfirmed: true,
  selectedSegment: 0,
  selectedStyle: 'cinematic',
  selectedVoice: 'magnetic',
  draftDirty: false,
  editorDirty: false,
  playing: false,
  modal: null,
  exporting: false,
  exportDone: false,
  exportRatio: '9:16',
  exportResolution: '1080p',
  exportTaskId: null,
  exportTaskStatus: 'idle',
  exportProgress: 0,
  exportError: null,
  scriptProgress: 0,
  generationProgress: 66,
  generationComplete: false,
  regenerating: false,
  generationTimer: null,
  exportTimer: null,
  toastTimer: null,
  activeProjectId: null,
  scriptTaskId: null,
  generationTaskId: null,
  generationTaskStatus: 'idle',
  generationTaskStep: 'queued',
  generationError: null,
  generationChildren: [],
  generationIdempotencyKey: null,
  scriptIdempotencyKey: null,
  scriptVersionId: null,
  scriptTaskStatus: 'idle',
  scriptTaskStep: 'queued',
  scriptError: null,
  visualBible: null,
  storyboardPlan: null,
  storyboardTaskId: null,
  storyboardTaskStatus: 'idle',
  storyboardTaskStep: 'queued',
  storyboardProgress: 0,
  storyboardError: null,
  storyboardIdempotencyKey: null,
  planningTab: 'director',
  submitPending: false,
  pollTimer: null,
  segmentSaveTimers: new Map(),
  segmentSaveStatus: new Map(),
  segmentSavePromises: new Map(),
  segments: [
    { title: '深夜地铁站', duration: '00:32', status: 'ready', script: '深夜十一点，沈砚在废弃的地铁站醒来。\n他记得自己正在参加一场葬礼，却想不起死者是谁。站台的电子屏反复闪烁着同一个时间：23:17。' },
    { title: '照片里的女孩', duration: '00:38', status: 'ready', script: '沈砚拿出手机，屏幕上多了一张陌生的照片。照片里是三年前的自己，身边站着一个看不清脸的女孩。照片背面写着一句话：不要让她上车。' },
    { title: '末班车', duration: '00:41', status: 'modified', script: '列车停在他面前时，车门缓缓打开。车厢里空无一人，唯独最后一排亮着一盏灯。那盏灯下，女孩抬起头，露出和照片里一模一样的侧脸。' },
    { title: '十分钟倒计时', duration: '00:36', status: 'ready', script: '她对沈砚说，第一班车已经错过了，而他只有十分钟可以活着离开这里。沈砚转身就跑，身后的站台却变成了没有尽头的隧道。' },
    { title: '自动生成的照片', duration: '00:39', status: 'ready', script: '手机再次亮起，新的照片正在自动生成。照片里，他已经坐在了女孩身边。可这一次，照片中的沈砚抬起了头。' },
    { title: '不要回头', duration: '00:34', status: 'ready', script: '隧道尽头传来脚步声，一步、两步，像是有人正沿着他的影子追来。沈砚终于明白，照片里的女孩一直都在等他回头。' },
  ],
  projects: [
    { title: '夜行者', genre: '悬疑', type: 'cover-night', cover: '夜行者', status: 'processing', statusText: '正在生成', duration: '预计 4:20', segments: '12 个片段', updated: '刚刚', progress: 66 },
    { title: '长安旧梦', genre: '历史', type: 'cover-heaven', cover: '长安旧梦', status: 'ready', statusText: '已完成', duration: '06:12', segments: '18 个片段', updated: '昨天', progress: 100 },
    { title: '逆光之城', genre: '都市', type: 'cover-city', cover: '逆光之城', status: 'draft', statusText: '文案草稿', duration: '—', segments: '待生成', updated: '9 月 4 日', progress: 0 },
  ],
};

const pageTitles = {
  dashboard: '工作台',
  create: '新建作品',
  'script-processing': '生成解说文案',
  'script-preview': '文案预览',
  'storyboard-processing': '前期策划',
  'shot-review': '前期策划审核',
  config: '生成配置',
  generation: '视频生成',
  editor: '视频编辑器',
  works: '我的作品',
  membership: '会员中心',
  help: '帮助与版权',
};

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

const API_BASE = '/api/v1';
const SESSION_KEY = 'wenying.activeProjectId';

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* empty response */ }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || '请求失败，请稍后重试');
    error.code = payload?.error?.code || 'REQUEST_FAILED';
    error.status = response.status;
    throw error;
  }
  return payload;
}

function sessionProjectId() {
  try { return localStorage.getItem(SESSION_KEY); } catch { return null; }
}

function saveSessionProjectId(projectId) {
  state.activeProjectId = projectId || null;
  try {
    if (projectId) localStorage.setItem(SESSION_KEY, projectId);
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* storage is optional */ }
}

function clientSegment(segment) {
  return {
    id: segment.id,
    title: segment.title,
    duration: segment.duration || formatDuration((segment.durationMs || 0) / 1000),
    durationMs: segment.durationMs || 0,
    status: segment.status || 'ready',
    script: segment.scriptText ?? segment.script ?? '',
    summary: segment.summary || '',
    revision: Number(segment.revision || 0),
    mediaStatus: segment.mediaStatus || 'pending',
    activeVersionId: segment.activeVersionId || null,
    versionId: segment.versionId || null,
    promptText: segment.promptText || '',
    voiceId: segment.voiceId || 'magnetic',
    visualStyle: segment.visualStyle || 'cinematic',
    media: Array.isArray(segment.media) ? segment.media.map(asset => ({ ...asset, url: asset.url || null })) : [],
    shots: Array.isArray(segment.shots) ? segment.shots.map(shot => ({ ...shot })) : [],
  };
}

function syncProjectState(payload) {
  if (!payload?.project) return;
  const project = payload.project;
  saveSessionProjectId(project.id);
  state.title = project.title || state.title;
  state.genre = project.genre || state.genre;
  state.scriptVersionId = payload.version?.id || project.draftScriptVersionId || project.activeScriptVersionId || null;
  if (Array.isArray(payload.segments) && payload.segments.length) {
    state.segments = payload.segments.map(clientSegment);
  }
  if (payload.task && !payload.task.type && !payload.task.storyboardPlanId) {
    state.scriptTaskId = payload.task.id;
    state.scriptTaskStatus = payload.task.status;
    state.scriptTaskStep = payload.task.step;
    state.scriptProgress = payload.task.progress || 0;
    state.scriptError = payload.task.errorMessage || null;
  }
  if (payload.visualBible) state.visualBible = payload.visualBible;
  if (payload.storyboardPlan) state.storyboardPlan = payload.storyboardPlan;
  const storyboardTask = payload.storyboardTask || (payload.task?.storyboardPlanId ? payload.task : null);
  if (storyboardTask) {
    state.storyboardTaskId = storyboardTask.id;
    state.storyboardTaskStatus = storyboardTask.status;
    state.storyboardTaskStep = storyboardTask.step;
    state.storyboardProgress = storyboardTask.progress || 0;
    state.storyboardError = storyboardTask.errorMessage || null;
  }
  const generationTask = payload.generationTask || (payload.task?.type ? payload.task : null);
  if (generationTask) {
    state.generationTaskId = generationTask.id;
    state.generationTaskStatus = generationTask.status;
    state.generationTaskStep = generationTask.step;
    state.generationProgress = generationTask.progress || 0;
    state.generationError = generationTask.errorMessage || null;
    state.generationChildren = Array.isArray(payload.generationChildren) ? payload.generationChildren : [];
  }
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function pollScriptTask() {
  if (!state.scriptTaskId) return;
  try {
    const payload = await apiRequest(`/script-tasks/${state.scriptTaskId}`);
    syncProjectState(payload);
    const task = payload.task;
    if (task.status === 'succeeded') {
      stopPolling();
      state.submitPending = false;
      state.scriptError = null;
      state.selectedSegment = 0;
      state.view = 'script-preview';
      render();
      showToast('解说文案已生成，可以开始逐段确认。');
    } else if (task.status === 'failed') {
      stopPolling();
      state.submitPending = false;
      state.scriptError = task.errorMessage || '文案生成失败，请稍后重试';
      if (state.view === 'script-processing') render();
    } else if (state.view === 'script-processing') {
      render();
    }
  } catch (error) {
    state.scriptError = error.message;
    if (state.view === 'script-processing') render();
  }
}

function startPolling(taskId) {
  stopPolling();
  state.scriptTaskId = taskId;
  void pollScriptTask();
  state.pollTimer = setInterval(() => void pollScriptTask(), 900);
}

async function pollGenerationTask() {
  if (!state.generationTaskId) return;
  try {
    const payload = await apiRequest(`/generation-tasks/${state.generationTaskId}`);
    syncProjectState(payload);
    const task = payload.generationTask || payload.task;
    if (!task) return;
    if (['succeeded', 'failed', 'partial_failed', 'canceled'].includes(task.status)) {
      stopPolling();
      state.generationComplete = task.status === 'succeeded';
      if (task.status === 'succeeded') {
        state.regenerating = false;
        state.view = task.type === 'segment' ? 'editor' : 'generation';
        render();
        showToast(task.type === 'segment' ? '本段已重新生成，已替换为新版本。' : '视频片段全部生成完成，进入编辑器预览吧。');
      } else if (state.view === 'generation') {
        state.regenerating = false;
        render();
      } else if (task.type === 'segment') {
        state.regenerating = false;
        state.view = 'editor';
        render();
        showToast(task.errorMessage || '本段生成失败，当前可用版本未受影响。', 'error');
      }
    } else if (state.view === 'generation') {
      render();
    }
  } catch (error) {
    state.generationError = error.message;
    if (state.view === 'generation') render();
  }
}

function startGenerationPolling(taskId) {
  stopPolling();
  state.generationTaskId = taskId;
  void pollGenerationTask();
  state.pollTimer = setInterval(() => void pollGenerationTask(), 800);
}

async function pollStoryboardTask() {
  if (!state.storyboardTaskId) return;
  try {
    const payload = await apiRequest(`/storyboard-tasks/${state.storyboardTaskId}`);
    syncProjectState(payload);
    const task = payload.storyboardTask || payload.task;
    if (task.status === 'succeeded') {
      stopPolling();
      state.submitPending = false;
      state.storyboardError = null;
      state.planningTab = 'director';
      state.view = 'shot-review';
      render();
      showToast('三层前期策划已生成，可以开始审核。');
    } else if (task.status === 'failed') {
      stopPolling();
      state.submitPending = false;
      state.storyboardError = task.errorMessage || '前期策划生成失败';
      render();
    } else if (state.view === 'storyboard-processing') render();
  } catch (error) {
    state.storyboardError = error.message;
    if (state.view === 'storyboard-processing') render();
  }
}

function startStoryboardPolling(taskId) {
  stopPolling();
  state.storyboardTaskId = taskId;
  void pollStoryboardTask();
  state.pollTimer = setInterval(() => void pollStoryboardTask(), 800);
}

async function restoreSession() {
  const projectId = sessionProjectId();
  if (!projectId) return;
  try {
    const payload = await apiRequest(`/projects/${projectId}`);
    syncProjectState(payload);
    const status = payload.project.status;
    if (payload.task && ['pending', 'running'].includes(payload.task.status)) {
      state.view = 'script-processing';
      render();
      startPolling(payload.task.id);
    } else if (payload.storyboardTask && ['pending', 'running'].includes(payload.storyboardTask.status)) {
      state.view = 'storyboard-processing';
      render();
      startStoryboardPolling(payload.storyboardTask.id);
    } else if (payload.generationTask && ['pending', 'running'].includes(payload.generationTask.status)) {
      state.view = 'generation';
      state.generationComplete = false;
      render();
      startGenerationPolling(payload.generationTask.id);
    } else if (payload.task?.status === 'failed' || status === 'script_failed') {
      state.view = 'script-processing';
      render();
    } else if (payload.storyboardTask?.status === 'failed') {
      state.view = 'storyboard-processing';
      render();
    } else if (status === 'script_ready' && state.segments.length) {
      state.view = 'script-preview';
      render();
    } else if (status === 'script_confirmed') {
      state.view = 'config';
      render();
    } else if (status === 'storyboard_review' || status === 'storyboard_confirmed') {
      state.view = 'shot-review';
      render();
    } else if (['ready', 'partial_failed', 'video_failed'].includes(status) && state.segments.length) {
      state.generationComplete = status === 'ready';
      state.view = status === 'ready' ? 'editor' : 'generation';
      render();
    }
  } catch {
    saveSessionProjectId(null);
  }
}

function totalSegmentSeconds() {
  return state.segments.reduce((total, segment) => total + (segment.durationMs ? segment.durationMs / 1000 : parseDuration(segment.duration)), 0);
}

function parseDuration(value = '') {
  const [minutes, seconds] = String(value).split(':').map(Number);
  return (minutes || 0) * 60 + (seconds || 0);
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const min = Math.floor(total / 60);
  const sec = String(total % 60).padStart(2, '0');
  return `${min}:${sec}`;
}

function estimate() {
  const chars = Array.from(state.sourceText).length;
  // 测试阶段允许极短正文：有内容时从 1 段开始，不再人为设置数量下限。
  const segments = chars ? Math.max(1, Math.ceil(chars / 135)) : 0;
  const seconds = chars ? Math.max(2, Math.round(chars / 4.2)) : 0;
  return { chars, segments, seconds, credits: segments };
}

function navItem(view, label, iconName, badge = '') {
  const active = state.view === view || (view === 'create' && ['create', 'script-processing', 'script-preview', 'config', 'storyboard-processing', 'shot-review', 'generation'].includes(state.view));
  return `<button class="nav-item${active ? ' active' : ''}" data-action="navigate" data-view="${view}" aria-current="${active ? 'page' : 'false'}">
    <span class="nav-icon">${icon(iconName, 17)}</span><span class="nav-text">${label}</span>${badge ? `<span class="nav-badge">${badge}</span>` : ''}
  </button>`;
}

function sidebar() {
  return `<aside class="sidebar">
    <a class="brand" href="#" data-action="navigate" data-view="dashboard" aria-label="返回工作台">
      <span class="brand-mark"><span>文</span></span>
      <span class="brand-copy"><span class="brand-name">文影</span><span class="brand-caption">STORY TO SCREEN</span></span>
    </a>
    <nav class="side-nav" aria-label="主导航">
      <div class="nav-label">创作空间</div>
      ${navItem('dashboard', '工作台', 'grid')}
      ${navItem('create', '新建作品', 'plus')}
      ${navItem('works', '我的作品', 'folder', '12')}
      <div class="nav-label" style="margin-top: 24px">账户服务</div>
      ${navItem('membership', '会员中心', 'crown')}
      ${navItem('help', '帮助与版权', 'help')}
    </nav>
    <div class="sidebar-footer">
      <div class="help-card">
        <strong>第一次使用文影？</strong>
        <p>从一段小说正文开始，5 分钟做出你的第一条视频。</p>
        <button class="help-link" data-action="navigate" data-view="help">查看创作指南 ${icon('arrow', 12)}</button>
      </div>
      <div class="user-mini">
        <span class="avatar">林</span>
        <span class="user-mini-copy"><strong>林老师</strong><span>创作者会员</span></span>
        ${icon('chevron', 14)}
      </div>
    </div>
  </aside>`;
}

function topbar() {
  const title = pageTitles[state.view] || '工作台';
  return `<header class="topbar">
    <div class="breadcrumb">文影创作空间 <span style="margin:0 7px;color:#c6c8d5">/</span> <strong>${title}</strong></div>
    <div class="topbar-actions">
      <label class="search-box">${icon('search', 15)}<input placeholder="搜索作品" aria-label="搜索作品" /></label>
      <button class="icon-button notification" data-action="notifications" aria-label="通知">${icon('bell', 17)}</button>
      <div class="topbar-user"><span class="avatar">林</span><span class="topbar-user-copy"><strong>林老师</strong><span>创作者会员</span></span>${icon('chevron', 13)}</div>
    </div>
  </header>`;
}

function pageHeader(eyebrow, title, subtitle, action = '') {
  return `<div class="page-header"><div><div class="eyebrow">${eyebrow}</div><h1 class="page-title">${title}</h1>${subtitle ? `<p class="page-subtitle">${subtitle}</p>` : ''}</div>${action}</div>`;
}

function dashboardView() {
  const processing = state.projects[0];
  return `<section class="page dashboard-page">
    ${pageHeader('MONDAY · 09 SEPTEMBER', '早上好，林老师', '准备好把今天的灵感，变成下一条爆款了吗？', `<button class="btn btn-primary" data-action="open-create">${icon('plus', 15)} 新建作品</button>`)}
    <div class="hero">
      <div class="hero-copy">
        <div class="hero-kicker"><i></i> AI 影像创作助手 · 让故事先被看见</div>
        <h2>把小说里的每一个<em>高光时刻</em>，变成可发布的视频。</h2>
        <p>粘贴正文，先确认解说文案，再由 AI 完成画面、配音与字幕。</p>
        <div class="hero-actions"><button class="btn btn-primary" data-action="open-create">开始创作 ${icon('arrow', 14)}</button><button class="btn btn-ghost" data-action="navigate" data-view="help">了解工作流 ${icon('chevronRight', 13)}</button></div>
      </div>
      <div class="hero-art" aria-hidden="true"><div class="art-orbit"></div><div class="art-card left"><span class="art-card-label">A STORY IN MOTION</span></div><div class="art-card right"><span class="art-card-label">THE LAST TRAIN</span></div><span class="art-play">${icon('play', 15)}</span></div>
    </div>
    <div class="metrics">
      <div class="metric-card"><span class="metric-icon">${icon('spark', 19)}</span><span class="metric-copy"><span class="metric-label">本月剩余生成额度</span><span class="metric-value">24 <span class="metric-note">+ 30 / 月</span></span></span></div>
      <div class="metric-card"><span class="metric-icon orange">${icon('clock', 19)}</span><span class="metric-copy"><span class="metric-label">进行中的任务</span><span class="metric-value">01 <span class="metric-note" style="color:var(--warning)">生成中</span></span></span></div>
      <div class="metric-card"><span class="metric-icon green">${icon('video', 19)}</span><span class="metric-copy"><span class="metric-label">本月已生成视频</span><span class="metric-value">12 <span class="metric-note">↑ 28%</span></span></span></div>
    </div>
    <div class="dashboard-grid">
      <div>
        <div class="section-head"><div><h3>最近作品</h3><p style="margin-top:4px">继续你的创作，灵感不会等待</p></div><button class="text-link" data-action="navigate" data-view="works">查看全部 ${icon('arrow', 12)}</button></div>
        <div class="project-grid">${state.projects.map((project, index) => projectCard(project, index)).join('')}</div>
      </div>
      <div class="queue-column">
        <div class="queue-card"><div class="section-head"><h3>生成队列</h3><span class="live-badge"><i></i>实时</span></div>
          <div class="queue-item"><span class="queue-icon">${icon('wand', 15)}</span><span class="queue-copy"><strong>${processing.title} · 视频生成</strong><span>正在生成第 8 / 12 个片段</span><span class="queue-progress"><i style="width:${processing.progress}%"></i></span></span><span class="queue-percent">${processing.progress}%</span></div>
          <div class="queue-item"><span class="queue-icon" style="color:#e6966d;background:var(--orange-soft)">${icon('edit', 15)}</span><span class="queue-copy"><strong>逆光之城 · 文案草稿</strong><span>等待你的确认</span></span><button class="icon-button" data-action="open-create" aria-label="继续编辑">${icon('chevronRight', 15)}</button></div>
        </div>
        <div class="quota-card"><div class="quota-top"><span class="quota-label">会员额度</span><span class="quota-tag">创作者会员</span></div><div class="quota-number">24 <span>/ 30 次剩余</span></div><div class="quota-bar"><i></i></div><div class="quota-bottom"><span>本月 9 月 1 日重置</span><button data-action="navigate" data-view="membership">升级套餐 ${icon('arrow', 11)}</button></div></div>
      </div>
    </div>
  </section>`;
}

function projectCard(project, index) {
  const action = project.status === 'draft' ? 'open-create' : 'open-editor';
  return `<article class="project-card"><div class="cover ${project.type}"><span class="cover-lines"></span><span class="cover-character"></span><span class="cover-copy"><span class="cover-kicker">${project.genre.toUpperCase()} · AI STORY</span><span class="cover-title">${project.cover}</span></span></div><div class="project-body"><div class="project-title-row"><strong>${project.title}</strong><span class="status-pill ${project.status === 'processing' ? 'processing' : project.status === 'draft' ? 'draft' : ''}">${project.statusText}</span></div><div class="project-meta"><span>${project.duration}</span><span>${project.segments}</span></div><div class="card-footer"><small>更新于 ${project.updated}</small><button class="btn btn-soft" data-action="${action}" data-project="${index}">${project.status === 'draft' ? '继续编辑' : '打开作品'} ${icon('arrow', 11)}</button></div></div></article>`;
}

function workflowSteps(active) {
  const labels = ['输入内容', '文案预览', '生成配置', '前期策划', '视频生成', '视频编辑'];
  return `<div class="steps">${labels.map((label, index) => {
    const number = index + 1;
    const done = number < active;
    return `<div class="step ${done ? 'done' : number === active ? 'active' : ''}"><span class="step-number">${done ? icon('check', 13, 2.4) : number}</span><span>${label}</span></div>${index < labels.length - 1 ? '<span class="step-line"></span>' : ''}`;
  }).join('')}</div>`;
}

function backRow(label = '返回工作台') {
  return `<div class="back-row"><button class="back-button" data-action="navigate" data-view="dashboard">${icon('back', 15)} ${label}</button></div>`;
}

function createView() {
  const data = estimate();
  return `<section class="page workflow-page">${backRow()}<div style="margin-bottom:27px"><div class="eyebrow">CREATE A NEW STORY</div><h1 class="workflow-title">新建作品</h1><p class="workflow-subtitle">先把故事交给我们，确认文案后再开始消耗视频额度。</p></div>${workflowSteps(1)}<div class="form-layout"><div class="panel pad"><div class="panel-heading"><div><h3>输入小说内容</h3><p>支持 1–30,000 字中文正文，测试阶段可使用短文本。</p></div><span class="status-pill draft">第 1 步</span></div><div class="field"><label class="field-label" for="project-title">作品名称 <small>1–50 个字符</small></label><input id="project-title" class="input" data-field="projectTitle" value="${escapeHtml(state.title)}" placeholder="例如：夜行者" maxlength="50" /></div><div class="field"><div class="field-label">选择题材 <small>影响文案节奏与画面风格</small></div><div class="genre-list">${['玄幻', '都市', '悬疑', '言情', '历史', '科幻', '其他'].map(g => `<button class="genre-chip ${state.genre === g ? 'active' : ''}" data-action="select-genre" data-genre="${g}">${g}</button>`).join('')}</div></div><div class="field"><label class="field-label" for="source-text">小说正文 <small>建议先粘贴一章</small></label><textarea id="source-text" class="textarea" data-field="sourceText" spellcheck="false" maxlength="30000">${escapeHtml(state.sourceText)}</textarea><div class="char-row ${data.chars >= 1 && data.chars <= 30000 ? 'valid' : 'warning'}"><span data-role="source-hint">${data.chars < 1 ? '正文不能为空' : data.chars > 30000 ? '正文不能超过 30,000 字' : '内容长度符合生成要求'}</span><span><b data-role="source-count">${data.chars.toLocaleString()}</b> / 30,000 字</span></div></div><label class="check-row"><input type="checkbox" data-field="copyrightConfirmed" ${state.copyrightConfirmed ? 'checked' : ''} /><span>我确认已获得相关内容的合法使用授权，并同意遵守 <a href="#" data-action="navigate" data-view="help">平台使用与版权规则</a>。</span></label></div><aside class="estimate-card"><h3>生成预估</h3><p>AI 会先为你改写解说文案，不消耗视频额度。</p><div class="estimate-grid"><div class="estimate-item"><span>预计片段</span><strong data-role="estimate-segments">${data.segments}<small> 段</small></strong></div><div class="estimate-item"><span>预计时长</span><strong data-role="estimate-duration">${formatDuration(data.seconds)}</strong></div><div class="estimate-item"><span>文案处理</span><strong style="color:#8fe0bf">免费</strong></div><div class="estimate-item"><span>视频额度</span><strong data-role="estimate-credits">约 ${data.credits}<small> 次</small></strong></div></div><div class="estimate-divider"></div><div class="estimate-notice">${icon('info', 14)}<span>视频会在你确认文案后生成。生成过程中可以离开页面，任务会继续运行。</span></div><button class="btn estimate-action" data-action="start-script" ${state.submitPending ? 'disabled' : ''}>${state.submitPending ? '正在创建任务…' : '开始生成解说文案'} ${icon('arrow', 14)}</button></aside></div></section>`;
}

function processingView() {
  const progress = Math.round(state.scriptProgress);
  const failed = state.scriptTaskStatus === 'failed';
  const steps = [
    ['准备文本', progress > 5 ? '已完成' : failed ? '未完成' : '处理中', progress > 5 ? 'done' : failed ? '' : 'active'],
    ['生成解说文案', progress >= 72 ? '已完成' : failed && state.scriptTaskStep === 'failed' ? '未完成' : '处理中', progress >= 72 ? 'done' : failed ? '' : 'active'],
    ['自动切分片段', progress >= 90 ? '已完成' : progress >= 25 ? '处理中' : '等待中', progress >= 90 ? 'done' : progress >= 25 ? 'active' : ''],
    ['校验生成结果', progress >= 100 ? '已完成' : progress >= 90 ? '处理中' : '等待中', progress >= 100 ? 'done' : progress >= 90 ? 'active' : ''],
  ];
  return `<section class="page workflow-page">${backRow()}<div style="margin-bottom:27px"><div class="eyebrow">AI SCRIPT ENGINE</div><h1 class="workflow-title">${failed ? '文案生成遇到问题' : '正在理解你的故事'}</h1><p class="workflow-subtitle">${escapeHtml(state.title)} · 文案处理完成后，你可以逐段修改。</p></div>${workflowSteps(1)}<div class="processing-wrap"><div class="processing-card ${failed ? 'processing-failed' : ''}"><div class="processing-icon">${icon(failed ? 'info' : 'spark', 26, 1.6)}</div><h2>${failed ? '文案生成失败' : 'AI 正在为你提炼爽点'}</h2><p>${failed ? escapeHtml(state.scriptError || '文案生成失败，请稍后重试；本次未扣视频额度') : '通常需要 10–30 秒，请不用停留在当前页面。'}</p><div class="processing-bar"><i style="width:${progress}%"></i></div><div class="processing-meta"><span>${failed ? '任务已停止' : state.scriptTaskStep === 'rewriting' ? '正在生成解说文案…' : state.scriptTaskStep === 'segmenting' ? '正在自动切分片段…' : state.scriptTaskStep === 'validating' ? '正在校验结果…' : '正在准备文本…'}</span><strong>${progress}%</strong></div><div class="pipeline">${steps.map(item => `<div class="pipeline-item ${item[2]}"><strong>${item[0]}</strong><span>${item[1]}</span></div>`).join('')}</div>${failed ? `<div class="task-error-actions"><button class="btn btn-primary btn-sm" data-action="retry-script">重试文案生成 ${icon('refresh', 13)}</button><button class="btn btn-ghost btn-sm" data-action="navigate" data-view="create">返回修改正文</button></div>` : ''}</div></div></section>`;
}

function scriptPreviewView() {
  const segment = state.segments[state.selectedSegment];
  if (!segment) return `<section class="page workflow-page">${backRow()}<div class="panel pad"><h3>暂无可编辑文案</h3><p>请返回任务页面重新加载文案。</p></div></section>`;
  const totalSeconds = Math.round(totalSegmentSeconds());
  const saveState = state.segmentSaveStatus.get(segment.id) || (state.draftDirty ? 'saving' : 'saved');
  const saveLabel = saveState === 'error' ? '保存失败' : saveState === 'saving' ? '正在保存' : '已自动保存';
  return `<section class="page workflow-page">${backRow()}<div style="margin-bottom:27px"><div class="eyebrow">SCRIPT PREVIEW</div><h1 class="workflow-title">确认解说文案</h1><p class="workflow-subtitle">AI 已完成改写。你可以编辑任意片段，确认后再生成高成本的视频素材。</p></div>${workflowSteps(2)}<div class="script-layout"><aside class="segment-sidebar"><div class="segment-sidebar-head"><strong>片段目录</strong><span>${state.segments.length} 个片段</span></div><div class="segment-list">${state.segments.map((item, index) => `<button class="segment-item ${state.selectedSegment === index ? 'active' : ''}" data-action="select-segment" data-index="${index}"><span class="segment-no">${String(index + 1).padStart(2, '0')}</span><span class="segment-item-copy"><strong>${escapeHtml(item.title)}</strong><span>${Array.from(item.script).length} 字 · ${item.duration}</span><span class="segment-item-status ${item.status === 'modified' ? 'modified' : ''}">${item.status === 'modified' ? '已修改' : 'AI 已生成'}</span></span></button>`).join('')}</div></aside><div class="script-editor-card"><div class="editor-card-top"><div><h3>片段 ${String(state.selectedSegment + 1).padStart(2, '0')} · ${escapeHtml(segment.title)}</h3><p>文案会作为配音、字幕和画面生成的共同基础</p></div><span class="save-status ${saveState === 'saving' ? 'saving' : saveState === 'error' ? 'error' : ''}">${saveLabel}</span></div><textarea class="textarea" data-field="scriptText" spellcheck="false">${escapeHtml(segment.script)}</textarea><div class="editor-bottom"><span class="editor-bottom-meta"><span data-role="script-count">${Array.from(segment.script).length}</span> 字 · 预计口播 ${segment.duration}</span><button class="btn btn-ghost btn-sm" data-action="save-script" ${saveState === 'saving' ? 'disabled' : ''}>${icon('check', 13)} 保存本段</button></div></div><aside class="script-summary"><h3>内容摘要</h3><div class="summary-section"><div class="summary-label">全文预估</div><div class="summary-number">${formatDuration(totalSeconds)} <small>预计成片</small></div><div class="summary-data"><span>${state.segments.length} 个视频片段</span><span>约 ${formatDuration(totalSeconds)}</span></div></div><div class="summary-section"><div class="summary-label">题材标签</div><div class="tag-row"><span class="tag">${escapeHtml(state.genre)}</span><span class="tag warm">悬念开场</span><span class="tag warm">口播解说</span></div></div><div class="summary-section"><div class="summary-label">AI 处理内容</div><div class="summary-data"><span>保留关键剧情</span><span style="color:var(--success)">${icon('check', 12)} 已完成</span></div><div class="summary-data"><span>自动分段</span><span style="color:var(--success)">${icon('check', 12)} 已完成</span></div><div class="summary-data"><span>原文事实校验</span><span style="color:var(--success)">${icon('check', 12)} 已完成</span></div></div></aside></div><div class="bottom-action-bar"><p>${icon('lock', 13)} 文案确认后将创建不可变版本，之后的修改可在编辑器中单段重生成。</p><div class="action-group"><button class="btn btn-ghost btn-sm" data-action="save-script" ${state.submitPending ? 'disabled' : ''}>保存草稿</button><button class="btn btn-primary btn-sm" data-action="confirm-script" ${state.submitPending ? 'disabled' : ''}>${state.submitPending ? '正在确认…' : '确认文案并继续'} ${icon('arrow', 13)}</button></div></div></section>`;
}

const styles = [
  { id: 'cinematic', title: '电影写实', note: '光影自然，情绪沉浸', className: 'style-cinematic' },
  { id: 'anime', title: '国漫风', note: '线条利落，人物鲜明', className: 'style-anime' },
  { id: 'ink', title: '东方水墨', note: '留白意境，古风叙事', className: 'style-ink' },
  { id: 'cyber', title: '赛博霓虹', note: '高饱和，未来质感', className: 'style-cyber' },
];

function configView() {
  return `<section class="page workflow-page">${backRow()}<div style="margin-bottom:27px"><div class="eyebrow">VIDEO CONFIGURATION</div><h1 class="workflow-title">确定全片视觉基准</h1><p class="workflow-subtitle">这些设置会作为导演分析和镜头选择的共同约束。</p></div>${workflowSteps(3)}<div class="form-layout"><div class="panel pad"><div class="panel-heading"><div><h3>前期策划配置</h3><p>统一画面风格、配音和成片画幅。</p></div><span class="status-pill draft">${state.segments.length} 个片段</span></div><div class="field"><div class="field-label">画面风格 <small>全片统一</small></div><div class="style-grid">${styles.map(item => `<button class="style-option ${state.selectedStyle === item.id ? 'active' : ''} ${item.className}" data-action="select-style" data-style="${item.id}"><span class="style-preview"><i></i><b></b></span><span class="style-copy"><strong>${item.title}</strong><small>${item.note}</small></span>${state.selectedStyle === item.id ? `<span class="style-check">${icon('check', 12, 2.4)}</span>` : ''}</button>`).join('')}</div></div><div class="field"><div class="field-label">配音音色 <small>中文 · 普通话</small></div><div class="voice-grid"><button class="voice-option ${state.selectedVoice === 'steady' ? 'active' : ''}" data-action="select-voice" data-voice="steady"><span class="voice-avatar avatar-blue">沉</span><span><strong>沉稳男声</strong><small>低沉 · 叙事感</small></span><span class="voice-play">${icon('play', 11)}</span></button><button class="voice-option ${state.selectedVoice === 'sweet' ? 'active' : ''}" data-action="select-voice" data-voice="sweet"><span class="voice-avatar avatar-pink">甜</span><span><strong>甜美女声</strong><small>清晰 · 有亲和力</small></span><span class="voice-play">${icon('play', 11)}</span></button><button class="voice-option ${state.selectedVoice === 'magnetic' ? 'active' : ''}" data-action="select-voice" data-voice="magnetic"><span class="voice-avatar avatar-purple">磁</span><span><strong>磁性旁白</strong><small>沙哑 · 悬疑首选</small></span><span class="voice-play">${icon('play', 11)}</span></button></div></div><div class="field"><div class="field-label">成片画幅</div><div class="option-grid planning-ratio-grid">${['9:16', '16:9', '1:1'].map(ratio => `<button class="option-button ${state.exportRatio === ratio ? 'active' : ''}" data-action="select-ratio" data-ratio="${ratio}">${ratio}</button>`).join('')}</div></div></div><aside class="estimate-card"><h3>策划预估</h3><p>先完成三层策划审核，再消耗视频额度。</p><div class="estimate-grid"><div class="estimate-item"><span>剧情片段</span><strong>${state.segments.length}<small> 段</small></strong></div><div class="estimate-item"><span>预计时长</span><strong>${formatDuration(Math.round(totalSegmentSeconds()))}</strong></div><div class="estimate-item"><span>策划结构</span><strong>3<small> 层</small></strong></div><div class="estimate-item"><span>知识检索</span><strong>5<small> 个库</small></strong></div></div><div class="estimate-divider"></div><div class="estimate-notice">${icon('info', 14)}<span>导演分析、镜头选择和分镜表生成不调用视频模型。</span></div><button class="btn estimate-action" data-action="start-storyboard" ${state.submitPending ? 'disabled' : ''}>${state.submitPending ? '正在创建任务…' : '开始前期策划'} ${icon('spark', 14)}</button></aside></div></section>`;
}

function storyboardProcessingView() {
  const progress = Math.round(state.storyboardProgress || 0);
  const failed = state.storyboardTaskStatus === 'failed';
  const stages = [
    ['导演分析', 'analyzing_direction'], ['知识检索', 'retrieving_knowledge'],
    ['镜头选择', 'selecting_shots'], ['分镜编排', 'building_storyboard'],
  ];
  const currentIndex = Math.max(0, stages.findIndex(([, step]) => step === state.storyboardTaskStep));
  const currentLabel = storyboardStepLabel(state.storyboardTaskStep);
  return `<section class="page workflow-page">${backRow()}<div style="margin-bottom:27px"><div class="eyebrow">PRE-PRODUCTION</div><h1 class="workflow-title">${failed ? '前期策划需要处理' : '正在完成三层前期策划'}</h1><p class="workflow-subtitle">${escapeHtml(state.title)} · 当前步骤：${escapeHtml(currentLabel)}</p></div>${workflowSteps(4)}<div class="processing-wrap"><div class="processing-card ${failed ? 'processing-failed' : ''}"><div class="processing-icon">${icon(failed ? 'info' : 'spark', 26, 1.6)}</div><h2>${failed ? '策划任务未完成' : '导演与摄影方案生成中'}</h2><p>${failed ? escapeHtml(state.storyboardError || '任务失败，请稍后重试') : '系统正在结合剧情节拍和镜头知识库生成可审核方案。'}</p><div class="processing-bar"><i style="width:${progress}%"></i></div><div class="processing-meta"><span>${escapeHtml(currentLabel)}</span><strong>${progress}%</strong></div><div class="pipeline">${stages.map(([label], index) => { const done = state.storyboardTaskStatus === 'succeeded' || index < currentIndex; const active = index === currentIndex && !done; return `<div class="pipeline-item ${done ? 'done' : active ? 'active' : ''}"><strong>${label}</strong><span>${done ? '已完成' : active ? (failed ? '失败' : '处理中') : '等待中'}</span></div>`; }).join('')}</div>${failed ? `<div class="task-error-actions"><button class="btn btn-primary btn-sm" data-action="retry-storyboard">重试策划 ${icon('refresh', 13)}</button><button class="btn btn-ghost btn-sm" data-action="navigate" data-view="config">返回配置</button></div>` : ''}</div></div></section>`;
}

function storyboardStepLabel(step) {
  return ({
    queued: '等待任务启动', preparing: '准备策划上下文', building_visual_bible: '生成视觉设定',
    analyzing_direction: '导演分析', retrieving_knowledge: '检索镜头知识',
    selecting_shots: '镜头选择', building_storyboard: '分镜编排', review_ready: '等待审核',
  })[step] || '前期策划';
}

function shotReviewView() {
  const plan = state.storyboardPlan || {};
  const directorSegments = plan.directorAnalysis?.segments || [];
  const cameraSegments = plan.shotSelection?.segments || [];
  const shots = state.segments.flatMap((segment, index) => (segment.shots || []).map(shot => ({ ...shot, segmentTitle: `片段 ${index + 1} · ${segment.title}` })));
  const tabs = [['director', '导演分析'], ['camera', '镜头选择'], ['storyboard', '分镜表']];
  let content = '';
  if (state.planningTab === 'director') {
    content = `<div class="planning-beat-list">${directorSegments.flatMap((segment, segmentIndex) => (segment.beats || []).map((beat, index) => `<article class="planning-beat"><div class="planning-beat-head"><strong>片段 ${segmentIndex + 1} · 节拍 ${index + 1}</strong><span class="tag">${escapeHtml(beat.emotion || '')} ${Math.round(Number(beat.emotionIntensity || 0) * 100)}%</span></div><h4>${escapeHtml(beat.plot || '')}</h4><div class="planning-facts"><span><small>动作</small>${escapeHtml(beat.action || '')}</span><span><small>场景</small>${escapeHtml(beat.sceneType || '')}</span><span><small>叙事目的</small>${escapeHtml(beat.narrativePurpose || '')}</span></div></article>`)).join('')}</div>`;
  } else if (state.planningTab === 'camera') {
    content = `<div class="planning-camera-list">${cameraSegments.flatMap((segment, segmentIndex) => (segment.selections || []).map((selection, index) => `<article class="planning-camera-row"><div><strong>片段 ${segmentIndex + 1} · 镜头 ${index + 1}</strong><p>${escapeHtml(selection.selectionReason || '')}</p></div><div class="camera-specs"><span>${escapeHtml(selection.shotSize)}</span><span>${escapeHtml(selection.angle)}</span><span>${escapeHtml(selection.movement)}</span><span>${escapeHtml(selection.composition)}</span><span>${escapeHtml(selection.focalLengthMm)}mm</span></div><div class="evidence-list">${(selection.evidenceIds || []).map(id => `<code>${escapeHtml(id)}</code>`).join('')}</div></article>`)).join('')}</div>`;
  } else {
    content = `<div class="storyboard-table-wrap"><table class="storyboard-table"><thead><tr><th>镜头</th><th>剧情</th><th>景别</th><th>运动</th><th>角度</th><th>目的</th><th>焦段</th></tr></thead><tbody>${shots.map(shot => `<tr><td><strong>${escapeHtml(shot.segmentTitle)}<br>镜头 ${shot.sequence}</strong><small>${escapeHtml(shot.duration || '')}</small></td><td><textarea data-shot-id="${escapeHtml(shot.id)}" data-shot-field="plot">${escapeHtml(shot.plot || '')}</textarea></td><td><select data-shot-id="${escapeHtml(shot.id)}" data-shot-field="shotSize">${['远景', '全景', '中景', '近景', '特写'].map(value => `<option ${shot.shotSize === value ? 'selected' : ''}>${value}</option>`).join('')}</select></td><td><input data-shot-id="${escapeHtml(shot.id)}" data-shot-field="movement" value="${escapeHtml(shot.movement || '')}"></td><td><input data-shot-id="${escapeHtml(shot.id)}" data-shot-field="angle" value="${escapeHtml(shot.angle || '')}"></td><td><textarea data-shot-id="${escapeHtml(shot.id)}" data-shot-field="purpose">${escapeHtml(shot.purpose || '')}</textarea></td><td><input type="number" min="12" max="200" data-shot-id="${escapeHtml(shot.id)}" data-shot-field="focalLengthMm" value="${Number(shot.focalLengthMm || 50)}"></td></tr>`).join('')}</tbody></table></div>`;
  }
  const regenerateLayer = state.planningTab === 'director' ? 'director' : state.planningTab === 'camera' ? 'camera' : 'storyboard';
  return `<section class="page workflow-page">${backRow()}<div style="margin-bottom:27px"><div class="eyebrow">PRE-PRODUCTION REVIEW</div><h1 class="workflow-title">审核前期策划</h1><p class="workflow-subtitle">${escapeHtml(state.title)} · ${shots.length} 个镜头 · ${plan.knowledgeSnapshot?.knowledgeBases?.length || 0} 个知识库</p></div>${workflowSteps(4)}<div class="planning-tabs">${tabs.map(([id, label]) => `<button class="${state.planningTab === id ? 'active' : ''}" data-action="select-planning-tab" data-tab="${id}">${label}</button>`).join('')}</div><div class="panel pad planning-panel">${content}</div><div class="bottom-action-bar"><p>${icon('lock', 13)} 确认后锁定本次策划版本，视频模型按分镜逐镜头生成。</p><div class="action-group"><button class="btn btn-ghost btn-sm" data-action="regenerate-storyboard" data-layer="${regenerateLayer}" ${state.submitPending ? 'disabled' : ''}>${icon('refresh', 13)} 从当前层重新生成</button><button class="btn btn-primary btn-sm" data-action="confirm-shots" ${state.submitPending ? 'disabled' : ''}>${state.submitPending ? '正在确认…' : '确认分镜并开始生成'} ${icon('arrow', 13)}</button></div></div></section>`;
}

function generationSteps(progress) {
  const names = ['解说文案', 'AI 配音', '中文分镜', '单镜头生成', '片段合成', '匹配 BGM'];
  const activeIndex = progress >= 94 ? 5 : progress >= 82 ? 4 : progress >= 48 ? 3 : progress >= 18 ? 1 : 0;
  return names.map((name, index) => `<div class="generation-step ${index < activeIndex ? 'done' : index === activeIndex && !state.generationComplete ? 'active' : index <= activeIndex ? 'done' : ''}" data-index="${index < activeIndex || state.generationComplete ? '✓' : index + 1}">${name}</div>`).join('');
}

function generationView() {
  const progress = Math.round(state.generationProgress);
  const taskStatus = state.generationTaskStatus;
  const complete = taskStatus === 'succeeded' || state.generationComplete;
  const failed = ['failed', 'partial_failed', 'canceled'].includes(taskStatus);
  const cardStates = state.segments.slice(0, 8).map((item, index) => {
    const child = state.generationChildren.find(candidate => candidate.segmentId === item.id);
    const ready = item.mediaStatus === 'ready';
    const running = ['generating', 'regenerating'].includes(item.mediaStatus) || ['pending', 'running'].includes(child?.status);
    const itemFailed = item.mediaStatus === 'failed' || child?.status === 'failed';
    const label = ready ? '已完成' : itemFailed ? '生成失败' : running ? '生成中…' : '排队中';
    return `<div class="generation-segment ${ready ? 'ready' : running ? 'running' : itemFailed ? 'failed' : ''}"><div class="segment-cover-mini"><span>SCENE ${String(index + 1).padStart(2, '0')}</span></div><div class="generation-segment-row"><strong>片段 ${String(index + 1).padStart(2, '0')}</strong><span>${item.duration}</span></div><span class="mini-state"><i></i>${label}</span></div>`;
  }).join('');
  const title = complete ? '视频已经准备好了' : failed ? '视频生成需要处理' : 'AI 正在制作你的影片';
  const subtitle = complete ? '所有片段已生成，可以进入编辑器预览。' : failed ? (state.generationError || '失败片段可以重试，已完成的片段会被保留。') : '你可以离开当前页面，任务会在后台继续运行。';
  const action = complete || taskStatus === 'partial_failed'
    ? `<button class="btn btn-primary btn-sm" data-action="open-editor">进入编辑器 ${icon('arrow', 12)}</button>`
    : failed
      ? `<button class="btn btn-primary btn-sm" data-action="retry-generation">重试任务 ${icon('refresh', 12)}</button>`
      : `<button class="btn btn-ghost btn-sm" data-action="navigate" data-view="dashboard">返回工作台</button>`;
  return `<section class="page workflow-page">${backRow()}<div class="generation-top"><div><div class="eyebrow">VIDEO GENERATION</div><h1 class="workflow-title">${title}</h1><p class="workflow-subtitle">${escapeHtml(state.title)} · ${escapeHtml(subtitle)}</p></div><div class="overall-progress"><div class="overall-progress-top"><span>总体进度</span><strong>${complete ? 100 : progress}%</strong></div><div class="overall-track"><i style="width:${complete ? 100 : progress}%"></i></div></div></div><div class="generation-panel"><div class="generation-panel-head"><div><h3>生成流水线</h3><p>当前步骤：${escapeHtml(state.generationTaskStep || '等待任务启动')}</p></div><span class="live-badge"><i></i>${complete ? '任务完成' : failed ? '任务异常' : '任务运行中'}</span></div><div class="generation-steps">${generationSteps(progress)}</div><div class="segment-progress-grid">${cardStates}</div><div class="generation-footer"><span>${icon('info', 13)} 重生成失败时，已可用的片段版本会继续保留。</span>${action}</div></div></section>`;
}

function voiceLabel(voiceId) {
  return voiceId === 'steady' ? '沉稳男声' : voiceId === 'sweet' ? '甜美女声' : '磁性旁白';
}

function editorView() {
  const segment = state.segments[state.selectedSegment];
  if (!segment) return `<section class="page editor-shell-page"><div class="panel pad"><h3>暂无可编辑片段</h3></div></section>`;
  const totalDuration = formatDuration(Math.round(totalSegmentSeconds()));
  const videoAsset = segment.media.find(asset => asset.type === 'video' && asset.status !== 'failed');
  const videoUrl = videoAsset?.url || null;
  const hasVideo = Boolean(videoUrl);
  const segmentState = segment.mediaStatus === 'ready' ? '就绪' : segment.mediaStatus === 'regenerating' ? '重新生成中' : segment.mediaStatus === 'generating' ? '生成中' : segment.mediaStatus === 'failed' ? '生成失败' : '等待生成';
  return `<section class="page editor-shell-page">
    <div class="editor-topbar">
      <div class="editor-title-wrap">
        <button class="back-button" data-action="navigate" data-view="dashboard">${icon('back', 15)} 返回作品</button>
        <span style="height:24px;width:1px;background:var(--line)"></span>
        <div><h1>${escapeHtml(state.title)}</h1><p>${escapeHtml(state.genre)} · ${state.segments.length} 个片段 · ${segmentState}</p></div>
        <span class="save-status ${state.editorDirty ? 'saving' : ''}">${state.editorDirty ? '待重新生成' : '已保存'}</span>
      </div>
      <div class="editor-actions">
        <button class="btn btn-ghost btn-sm" data-action="preview-full" ${hasVideo ? '' : 'disabled'}>${icon(state.playing ? 'pause' : 'play', 13)} ${state.playing ? '暂停预览' : '完整预览'}</button>
        <button class="btn btn-primary btn-sm" data-action="open-export" ${state.segments.some(item => item.mediaStatus !== 'ready') ? 'disabled' : ''}>${icon('download', 13)} 导出视频</button>
      </div>
    </div>
    <div class="editor-main">
      <div class="player-panel">
        <div class="video-stage ${hasVideo ? '' : 'video-stage-pending'}">
          <div class="video-overlay-top"><span>第 ${String(state.selectedSegment + 1).padStart(2, '0')} 段 · ${escapeHtml(segment.title)}</span><span>AI 生成内容</span></div>
          ${videoUrl ? `<video class="generated-video" controls playsinline preload="metadata" src="${escapeHtml(videoUrl)}"></video>` : '<div class="video-frame-character"></div>'}
          <div class="video-overlay-bottom"><div class="video-caption"><span>${escapeHtml(segment.script.slice(0, 29))}${segment.script.length > 29 ? '…' : ''}</span></div><span class="video-time">00:${segment.duration.slice(-2)} / ${totalDuration}</span></div>
        </div>
        <div class="player-controls">
          <button class="icon-button" data-action="previous-segment" aria-label="上一段">${icon('back', 14)}</button>
          <button class="play-control" data-action="preview-full" aria-label="播放" ${hasVideo ? '' : 'disabled'}>${icon(state.playing ? 'pause' : 'play', 14)}</button>
          <button class="icon-button" data-action="next-segment" aria-label="下一段">${icon('arrow', 14)}</button>
          <div class="player-track"><i></i></div><span class="player-time">01:06 / ${totalDuration}</span>
          <button class="icon-button" aria-label="音量">${icon('volume', 15)}</button>
        </div>
      </div>
      <aside class="properties-panel">
        <div class="properties-head"><h3>片段属性</h3><span>片段 ${String(state.selectedSegment + 1).padStart(2, '0')} · ${segmentState}</span></div>
        <div class="property-layout">
          <div class="property-group"><div class="property-label">解说文案 <span>${Array.from(segment.script).length} 字</span></div><textarea class="property-textarea" data-field="editorScript" spellcheck="false">${escapeHtml(segment.script)}</textarea></div>
          <div>
            <div class="property-group"><div class="property-label">配音音色</div><div class="voice-select-row"><span class="voice-avatar">${voiceLabel(segment.voiceId).slice(0, 1)}</span><span class="voice-copy"><strong>${voiceLabel(segment.voiceId)}</strong><span>语速 1.0x · 情绪自然</span></span><select class="mini-select" data-field="editorVoice" aria-label="选择配音音色"><option value="steady" ${segment.voiceId === 'steady' ? 'selected' : ''}>沉稳男声</option><option value="sweet" ${segment.voiceId === 'sweet' ? 'selected' : ''}>甜美女声</option><option value="magnetic" ${segment.voiceId === 'magnetic' ? 'selected' : ''}>磁性旁白</option></select></div></div>
            <div class="property-group"><div class="property-label">中文单镜头提示词 <span>${segment.shots.length} 个镜头</span></div>${segment.shots.length ? segment.shots.map((shot, shotIndex) => `<div class="shot-editor-row"><div class="shot-editor-meta"><span>镜头 ${String(shot.sequence || shotIndex + 1).padStart(2, '0')}</span><small>${shot.duration || ''}</small></div><textarea class="property-textarea shot-prompt-input" data-shot-id="${escapeHtml(shot.id)}" spellcheck="false">${escapeHtml(shot.promptZh || '')}</textarea></div>`).join('') : `<textarea class="property-textarea" data-field="promptText" spellcheck="false">${escapeHtml(segment.promptText)}</textarea>`}</div>
          </div>
        </div>
        <button class="btn btn-soft regenerate-button" data-action="regenerate-segment" ${state.regenerating ? 'disabled' : ''}>${state.regenerating ? icon('refresh', 13) + ' 正在重新生成…' : icon('refresh', 13) + ' 仅重新生成本段'}</button>
      </aside>
    </div>
    <div class="timeline-panel"><div class="timeline-head"><h3>片段时间线</h3><span>拖动排序将在后续版本开放 · 当前共 ${state.segments.length} 段</span></div><div class="timeline-track">${state.segments.map((item, index) => `<button class="timeline-segment ${state.selectedSegment === index ? 'active' : ''} ${item.mediaStatus !== 'ready' ? 'timeline-segment-pending' : ''}" data-action="select-segment" data-index="${index}"><div class="timeline-thumb"></div><div class="timeline-number"><strong>${String(index + 1).padStart(2, '0')} · ${escapeHtml(item.title)}</strong><span>${item.mediaStatus === 'ready' ? item.duration : item.mediaStatus === 'failed' ? '失败' : '生成中'}</span></div></button>`).join('')}</div></div>
  </section>`;
}

function worksView() {
  return `<section class="page"><div class="page-header"><div><div class="eyebrow">YOUR LIBRARY</div><h1 class="page-title">我的作品</h1><p class="page-subtitle">所有故事都在这里，随时回来继续创作。</p></div><button class="btn btn-primary" data-action="open-create">${icon('plus', 15)} 新建作品</button></div><div class="filter-row"><button class="filter-chip active">全部作品 <span style="margin-left:4px">12</span></button><button class="filter-chip">生成中</button><button class="filter-chip">已完成</button><button class="filter-chip">草稿</button><span style="flex:1"></span><button class="btn btn-ghost btn-sm">${icon('search', 13)} 搜索作品</button></div><div class="works-table"><div class="works-row header"><span>作品名称</span><span>状态</span><span>时长</span><span>最近更新</span><span>操作</span></div>${state.projects.concat([{ title: '雾中来信', genre: '言情', type: 'cover-night', cover: '雾中来信', status: 'ready', statusText: '已完成', duration: '03:44', segments: '10 个片段', updated: '8 月 28 日', progress: 100 }]).map((project, index) => `<div class="works-row"><div class="work-title-cell"><span class="work-thumb ${project.type.replace('cover-', '')}">${project.cover}</span><span class="work-title-copy"><strong>${project.title}</strong><span>${project.genre} · ${project.segments}</span></span></div><div><span class="status-pill ${project.status === 'processing' ? 'processing' : project.status === 'draft' ? 'draft' : ''}">${project.statusText}</span></div><span class="table-cell">${project.duration}</span><span class="table-cell muted">${project.updated}</span><button class="btn btn-ghost btn-sm" data-action="${project.status === 'draft' ? 'open-create' : 'open-editor'}" data-project="${index}">打开 ${icon('arrow', 11)}</button></div>`).join('')}</div></section>`;
}

function membershipView() {
  return `<section class="page"><div class="page-header"><div><div class="eyebrow">MEMBERSHIP</div><h1 class="page-title">会员中心</h1><p class="page-subtitle">把时间留给创作，把等待交给 AI。</p></div></div><div class="membership-hero"><div><div class="quota-tag" style="display:inline-flex;margin-bottom:15px">当前 · 创作者会员</div><h2>本月还有 24 次生成额度</h2><p>你的额度将在 9 月 30 日重置。会员作品默认保存 30 天，导出已有素材不重复扣费。</p><button class="btn btn-primary" data-action="show-toast">管理订阅 ${icon('arrow', 13)}</button></div><div class="membership-overview"><span class="membership-overview-label">本月额度使用情况</span><div class="membership-overview-number">6 <span>/ 30 次已使用</span></div><div class="quota-bar"><i style="width:20%"></i></div></div></div><div class="section-head" style="margin-top:31px"><div><h3>选择适合你的创作节奏</h3><p style="margin-top:4px">随时升级，已用额度不会丢失</p></div></div><div class="plan-grid"><div class="plan-card"><h3>体验版</h3><p>适合刚开始尝试小说解说的创作者</p><div class="plan-price">¥0 <span>/ 月</span></div><div class="plan-features"><div>每月 3 次生成额度</div><div>作品保存 7 天</div><div>720p 导出</div></div><button class="btn btn-ghost" disabled>当前方案</button></div><div class="plan-card recommended"><h3>创作者会员</h3><p>适合稳定更新的个人博主和小团队</p><div class="plan-price">¥49 <span>/ 月</span></div><div class="plan-features"><div>每月 30 次生成额度</div><div>作品保存 30 天</div><div>1080p 高清导出</div></div><button class="btn btn-primary" data-action="show-toast">续费会员 ${icon('arrow', 13)}</button></div><div class="plan-card"><h3>专业版</h3><p>适合高频更新和批量制作的团队</p><div class="plan-price">¥99 <span>/ 月</span></div><div class="plan-features"><div>不限量生成额度</div><div>优先生成队列</div><div>专属客服支持</div></div><button class="btn btn-ghost" data-action="show-toast">升级专业版 ${icon('arrow', 13)}</button></div></div></section>`;
}

function helpView() {
  return `<section class="page"><div class="page-header"><div><div class="eyebrow">GUIDE & COPYRIGHT</div><h1 class="page-title">帮助与版权</h1><p class="page-subtitle">从正文到成片，四步完成一次创作。</p></div></div><div class="help-guide-grid"><div class="guide-card"><span class="guide-number">01</span><span class="guide-icon">${icon('edit', 19)}</span><h3>粘贴小说正文</h3><p>输入 1–30,000 字正文，选择题材并确认你拥有合法使用权。</p></div><div class="guide-card"><span class="guide-number">02</span><span class="guide-icon">${icon('wand', 19)}</span><h3>确认解说文案</h3><p>AI 会提炼爽点并自动分段。视频生成前，你可以逐段修改。</p></div><div class="guide-card"><span class="guide-number">03</span><span class="guide-icon">${icon('video', 19)}</span><h3>生成并精修</h3><p>选择画面和音色，生成完成后可在编辑器中单独重做任意片段。</p></div><div class="guide-card"><span class="guide-number">04</span><span class="guide-icon">${icon('download', 19)}</span><h3>导出发布</h3><p>选择 9:16 / 16:9 / 1:1 比例与分辨率，在线播放或下载 MP4。</p></div></div><div class="help-columns"><div class="panel pad"><h3 class="help-section-title">版权与 AI 生成提示</h3><div class="help-text"><p>文影只处理你提交的内容，不代表你拥有该小说或生成素材的版权。请在生成前确认已获得相关内容的合法使用授权。</p><p>导出视频默认包含 AI 生成标识。请根据发布平台和所在地区的规定，完成必要的声明与审核。</p><p>我们默认不长期保存原始小说正文；生成完成后会按隐私策略清理原文数据。视频素材保存时长取决于你的会员方案。</p></div></div><div class="panel pad"><h3 class="help-section-title">常见问题</h3><div class="faq-row"><strong>生成任务可以中途离开吗？</strong>${icon('chevronRight', 14)}</div><div class="faq-row"><strong>重生成会重复扣除整条视频额度吗？</strong>${icon('chevronRight', 14)}</div><div class="faq-row"><strong>导出已有视频需要再次扣费吗？</strong>${icon('chevronRight', 14)}</div><button class="btn btn-soft btn-sm" data-action="show-toast">联系人工客服 ${icon('arrow', 12)}</button></div></div></section>`;
}

function exportModal() {
  if (!state.modal) return '';
  if (state.modal === 'export-done') {
    return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" data-modal-content><div class="modal-head"><div><h3>导出完成</h3><p>你的影片已经准备好，可以在线播放或下载。</p></div><button class="modal-close" data-action="close-modal" aria-label="关闭">${icon('close', 16)}</button></div><div class="export-success"><div class="export-success-icon">${icon('check', 25, 2.4)}</div><h4>${escapeHtml(state.title)}.mp4</h4><p>1080p · 9:16 · 约 48.6 MB</p></div><div class="modal-footer"><button class="btn btn-ghost" data-action="close-modal">稍后处理</button><button class="btn btn-primary" data-action="download-export">${icon('download', 14)} 下载视频</button></div></div></div>`;
  }
  if (state.exporting) {
    const progress = Math.max(0, Math.min(100, state.exportProgress));
    return `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><h3>正在合成视频</h3><p>使用当前片段版本生成 ${state.exportRatio} MP4。</p></div></div><div class="processing-wrap" style="margin:12px auto 18px"><div class="processing-card" style="padding:25px 20px"><div class="processing-icon" style="width:48px;height:48px;margin-bottom:14px">${icon('spark', 21)}</div><h2 style="font-size:16px">正在处理素材</h2><p style="margin-bottom:19px">正在混合配音、BGM 与字幕…</p><div class="processing-bar"><i style="width:${progress}%"></i></div><div class="processing-meta" style="margin-bottom:0"><span>导出任务进行中</span><strong>${progress}%</strong></div></div></div></div></div>`;
  }
  return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" data-modal-content><div class="modal-head"><div><h3>导出视频</h3><p>选择成片比例与清晰度，已有素材不会重复扣额度。</p></div><button class="modal-close" data-action="close-modal" aria-label="关闭">${icon('close', 16)}</button></div><div class="option-title">视频比例</div><div class="option-grid">${['9:16', '16:9', '1:1'].map(r => `<button class="option-button ${state.exportRatio === r ? 'active' : ''}" data-action="select-ratio" data-ratio="${r}">${r}<span>${r === '9:16' ? '抖音 / 小红书' : r === '16:9' ? 'B站 / 横屏' : '社交平台'}</span></button>`).join('')}</div><div class="option-title">分辨率</div><div class="option-grid" style="grid-template-columns:1fr 1fr">${['720p', '1080p'].map(r => `<button class="option-button ${state.exportResolution === r ? 'active' : ''}" data-action="select-resolution" data-resolution="${r}">${r}<span>${r === '720p' ? '标准清晰度' : '高清 · 推荐'}</span></button>`).join('')}</div><div class="modal-notice">${icon('info', 14)}<span>导出视频会保留 AI 生成标识，并包含必要的版权提示。预计文件大小约 48.6 MB。</span></div><div class="modal-footer space-between"><span style="color:var(--muted);font-size:10px">预计时长 04:18 · 不消耗生成额度</span><button class="btn btn-primary" data-action="start-export">${icon('download', 14)} 开始导出</button></div></div></div>`;
}

function currentView() {
  switch (state.view) {
    case 'create': return createView();
    case 'script-processing': return processingView();
    case 'script-preview': return scriptPreviewView();
    case 'storyboard-processing': return storyboardProcessingView();
    case 'shot-review': return shotReviewView();
    case 'config': return configView();
    case 'generation': return generationView();
    case 'editor': return editorView();
    case 'works': return worksView();
    case 'membership': return membershipView();
    case 'help': return helpView();
    default: return dashboardView();
  }
}

function render() {
  app.innerHTML = `<div class="app-shell">${sidebar()}<main class="main">${topbar()}${currentView()}</main></div>${exportModal()}`;
}

function showToast(message, type = 'success') {
  clearTimeout(state.toastTimer);
  toastRoot.innerHTML = `<div class="toast ${type === 'error' ? 'error' : ''}">${icon(type === 'error' ? 'info' : 'check', 15, 2.3)}<span>${escapeHtml(message)}</span></div>`;
  state.toastTimer = setTimeout(() => { toastRoot.innerHTML = ''; }, 3200);
}

function updateCreateEstimate() {
  const data = estimate();
  const count = document.querySelector('[data-role="source-count"]');
  const hint = document.querySelector('[data-role="source-hint"]');
  const segments = document.querySelector('[data-role="estimate-segments"]');
  const duration = document.querySelector('[data-role="estimate-duration"]');
  const credits = document.querySelector('[data-role="estimate-credits"]');
  if (count) count.textContent = data.chars.toLocaleString();
  if (hint) {
    hint.textContent = data.chars < 1 ? '正文不能为空' : data.chars > 30000 ? '正文不能超过 30,000 字' : '内容长度符合生成要求';
    hint.parentElement.classList.toggle('valid', data.chars >= 1 && data.chars <= 30000);
    hint.parentElement.classList.toggle('warning', data.chars < 1 || data.chars > 30000);
  }
  if (segments) segments.innerHTML = `${data.segments}<small> 段</small>`;
  if (duration) duration.textContent = formatDuration(data.seconds);
  if (credits) credits.innerHTML = `约 ${data.credits}<small> 次</small>`;
}

async function startScriptProcessing() {        //创建项目并提交脚本处理任务
  const data = estimate();                     //输入校验
  if (state.submitPending) return;
  const titleLength = Array.from(state.title.trim()).length;
  if (titleLength < 1 || titleLength > 50) {
    showToast('作品名称需要 1–50 个字符。', 'error');
    return;
  }
  if (data.chars < 1 || data.chars > 30000) {
    showToast('请输入 1–30,000 字的正文后再开始。', 'error');
    return;
  }
  if (!state.genre) {
    showToast('请选择小说题材。', 'error');
    return;
  }
  if (!state.copyrightConfirmed) {
    showToast('请先确认你拥有内容的合法使用权。', 'error');
    return;
  }
  state.submitPending = true;
  state.scriptError = null;
  render();    
                                 
  try {                                           //创建项目
    const projectResponse = await apiRequest('/projects', {
      method: 'POST',
      body: JSON.stringify({
        title: state.title.trim(),
        genre: state.genre,
        sourceText: state.sourceText,
        copyrightConfirmed: state.copyrightConfirmed,
      }),
    });

    syncProjectState({ project: projectResponse.project });                                          //创建脚本处理任务
    const idempotencyKey = state.scriptIdempotencyKey || `rewrite-${projectResponse.project.id}`;                // 生成幂等性 Key，防止重复提交
    state.scriptIdempotencyKey = idempotencyKey;
    const taskResponse = await apiRequest(`/projects/${projectResponse.project.id}/script-tasks`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
    });
    syncProjectState(taskResponse);
    state.view = 'script-processing';
    state.submitPending = false;
    render();
    startPolling(taskResponse.task.id);
  } catch (error) {
    state.submitPending = false;
    state.scriptError = error.message;
    render();
    showToast(error.message, 'error');
  }
}                                         

async function startGeneration() {
  if (state.submitPending || !state.activeProjectId) return;
  state.submitPending = true;
  state.generationError = null;
  state.view = 'generation';
  state.generationComplete = false;
  render();
  try {
    const idempotencyKey = state.generationIdempotencyKey || `video-${state.activeProjectId}-${Date.now()}`;
    state.generationIdempotencyKey = idempotencyKey;
    const payload = await apiRequest(`/projects/${state.activeProjectId}/generation-tasks`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        visualStyle: state.selectedStyle === 'ink' ? 'chinese' : state.selectedStyle === 'cyber' ? 'cyberpunk' : state.selectedStyle,
        voiceId: state.selectedVoice,
        subtitleStyle: 'basic-outline',
        bgmPolicy: 'auto',
      }),
    });
    syncProjectState(payload);
    state.submitPending = false;
    startGenerationPolling(payload.task.id);
    render();
  } catch (error) {
    state.submitPending = false;
    state.generationError = error.message;
    render();
    showToast(error.message, 'error');
  }
}

async function startStoryboardPlanning() {
  if (state.submitPending || !state.activeProjectId) return;
  state.submitPending = true;
  state.storyboardError = null;
  state.view = 'storyboard-processing';
  render();
  try {
    const idempotencyKey = state.storyboardIdempotencyKey || `storyboard-${state.activeProjectId}-${Date.now()}`;
    state.storyboardIdempotencyKey = idempotencyKey;
    const visualStyle = state.selectedStyle === 'ink' ? 'chinese' : state.selectedStyle === 'cyber' ? 'cyberpunk' : state.selectedStyle;
    const payload = await apiRequest(`/projects/${state.activeProjectId}/storyboard-tasks`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ visualStyle, voiceId: state.selectedVoice, ratio: state.exportRatio, platform: 'short-video' }),
    });
    syncProjectState(payload);
    state.submitPending = false;
    render();
    startStoryboardPolling(payload.task.id);
  } catch (error) {
    state.submitPending = false;
    state.storyboardError = error.message;
    render();
    showToast(error.message, 'error');
  }
}

async function confirmStoryboardAndGenerate() {
  if (!state.storyboardPlan?.id || state.submitPending) return;
  state.submitPending = true;
  render();
  try {
    if (state.visualBible?.id && !state.visualBible.confirmed) {
      const biblePayload = await apiRequest(`/visual-bibles/${state.visualBible.id}/confirm`, {
        method: 'PATCH',
        body: JSON.stringify({ revision: state.visualBible.revision, content: state.visualBible.content }),
      });
      state.visualBible = biblePayload.visualBible;
    }
    const payload = await apiRequest(`/storyboard-plans/${state.storyboardPlan.id}/confirm`, { method: 'POST' });
    syncProjectState(payload);
    state.submitPending = false;
    await startGeneration();
  } catch (error) {
    state.submitPending = false;
    render();
    showToast(error.message, 'error');
  }
}

async function regenerateStoryboardFrom(layer) {
  if (!state.storyboardPlan?.id || state.submitPending) return;
  state.submitPending = true;
  state.storyboardError = null;
  state.view = 'storyboard-processing';
  render();
  try {
    const idempotencyKey = `storyboard-${state.storyboardPlan.id}-${layer}-${Date.now()}`;
    const payload = await apiRequest(`/storyboard-plans/${state.storyboardPlan.id}/regenerate`, {
      method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ fromLayer: layer }),
    });
    syncProjectState(payload);
    state.submitPending = false;
    render();
    startStoryboardPolling(payload.task.id);
  } catch (error) {
    state.submitPending = false;
    state.storyboardError = error.message;
    render();
    showToast(error.message, 'error');
  }
}

async function regenerateCurrentSegment() {
  const segment = state.segments[state.selectedSegment];
  if (!segment?.id || state.regenerating) return;
  state.regenerating = true;
  state.generationError = null;
  render();
  try {
    const idempotencyKey = `segment-${segment.id}-${Date.now()}`;
    const visualStyle = segment.visualStyle === 'ink' ? 'chinese' : segment.visualStyle === 'cyber' ? 'cyberpunk' : segment.visualStyle;
    const payload = await apiRequest(`/segments/${segment.id}/regenerate`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        scriptText: segment.script,
        promptText: segment.promptText,
        shots: (segment.shots || []).map(shot => ({
          beatId: shot.beatId, plot: shot.plot, shotSize: shot.shotSize, movement: shot.movement,
          angle: shot.angle, focalLengthMm: shot.focalLengthMm, composition: shot.composition,
          purpose: shot.purpose, durationMs: shot.durationMs, selectionReason: shot.selectionReason,
          evidenceIds: shot.evidenceIds, promptZh: shot.promptZh,
        })),
        voiceId: segment.voiceId,
        visualStyle,
      }),
    });
    syncProjectState(payload);
    startGenerationPolling(payload.task.id);
    render();
  } catch (error) {
    state.regenerating = false;
    state.generationError = error.message;
    render();
    showToast(error.message, 'error');
  }
}

async function startExport() {
  if (!state.activeProjectId || state.exporting) return;
  state.exporting = true;
  state.exportDone = false;
  state.exportError = null;
  render();
  try {
    const idempotencyKey = `export-${state.activeProjectId}-${Date.now()}`;
    const payload = await apiRequest(`/projects/${state.activeProjectId}/export-tasks`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ ratio: state.exportRatio, resolution: state.exportResolution }),
    });
    state.exportTaskId = payload.task.id;
    state.exportTaskStatus = payload.task.status;
    state.exportProgress = payload.task.progress || 0;
    void pollExportTask();
  } catch (error) {
    state.exporting = false;
    state.exportError = error.message;
    render();
    showToast(error.message, 'error');
  }
}

async function pollExportTask() {
  if (!state.exportTaskId) return;
  try {
    const payload = await apiRequest(`/export-tasks/${state.exportTaskId}`);
    const task = payload.task;
    state.exportTaskStatus = task.status;
    state.exportProgress = task.progress || 0;
    if (task.status === 'succeeded') {
      state.exporting = false;
      state.exportDone = true;
      state.modal = 'export-done';
      render();
      showToast('视频导出任务已完成。');
      return;
    }
    if (task.status === 'failed') {
      state.exporting = false;
      state.exportError = task.errorMessage || '视频合成失败，素材未丢失。';
      render();
      showToast(state.exportError, 'error');
      return;
    }
    render();
    setTimeout(() => void pollExportTask(), 700);
  } catch (error) {
    state.exporting = false;
    state.exportError = error.message;
    render();
    showToast(error.message, 'error');
  }
}

function openEditor() {
  stopPolling();
  state.generationComplete = true;
  state.view = 'editor';
  state.selectedSegment = Math.min(state.selectedSegment, state.segments.length - 1);
  render();
}

async function saveCurrentSegment({ silent = false, force = false } = {}) {             //异步保存当前选中片段的函数
  const segment = state.segments[state.selectedSegment];
  if (!segment) return false;                                                            //当前没有选中片段 → 返回 false
  if (!force && segment.id && state.segmentSaveStatus.get(segment.id) !== 'dirty') return true;     //未强制保存且片段不是脏数据（未修改）→ 直接返回 true（无需保存）
  if (segment.id && state.segmentSavePromises.has(segment.id)) {    //该片段正在保存中 → 返回正在进行的 Promise，避免并发保存
    return state.segmentSavePromises.get(segment.id);
  }
  const text = String(segment.script || '').trim();
  if (!text) {                                                      //文案为空 → 标记状态为 error，提示"文案不能为空"，返回 false
    state.segmentSaveStatus.set(segment.id, 'error');
    if (!silent) showToast('文案不能为空。', 'error');
    return false;
  }
  if (!segment.id) {                                                //片段还没有 ID（未创建到后端）→ 清除草稿脏标记，返回 true（仅前端保存）
    state.draftDirty = false;
    return true;
  }
  state.segmentSaveStatus.set(segment.id, 'saving');
  if (!silent) render();
  const savePromise = (async () => {
    try {
      const payload = await apiRequest(`/segments/${segment.id}/draft`, {
        method: 'PATCH',
        body: JSON.stringify({ scriptText: text, revision: segment.revision || 0 }),
      });
      const saved = payload.segment;
      segment.script = saved.scriptText;
      segment.revision = saved.revision;
      segment.durationMs = saved.durationMs;
      segment.duration = saved.duration;
      segment.status = 'modified';
      state.draftDirty = false;
      state.segmentSaveStatus.set(segment.id, 'saved');
      if (!silent) {
        render();
        showToast('本段文案已保存。');
      }
      return true;
    } catch (error) {
      state.segmentSaveStatus.set(segment.id, 'error');
      if (!silent) {
        render();
        showToast(error.message, 'error');
      }
      return false;
    } finally {
      state.segmentSavePromises.delete(segment.id);
    }
  })();
  state.segmentSavePromises.set(segment.id, savePromise);
  return savePromise;
}

async function flushSegmentDrafts() {
  for (let index = 0; index < state.segments.length; index += 1) {
    const segment = state.segments[index];
    if (segment?.id && state.segmentSaveStatus.get(segment.id) === 'saving' && state.segmentSavePromises.has(segment.id)) {
      await state.segmentSavePromises.get(segment.id);
      continue;
    }
    if (segment?.id && state.segmentSaveStatus.get(segment.id) === 'dirty') {
      const previous = state.selectedSegment;
      state.selectedSegment = index;
      await saveCurrentSegment({ silent: true });
      state.selectedSegment = previous;
    }
  }
}

async function confirmScript() {
    if (state.submitPending) return;
  state.submitPending = true;
  render();
  await flushSegmentDrafts();
  const invalid = state.segments.find(segment => !String(segment.script || '').trim());
  if (invalid) {
    state.submitPending = false;
    render();
    showToast('文案不能为空，请补充后再确认。', 'error');
    return;
  }
  try {
    const payload = await apiRequest(`/projects/${state.activeProjectId}/script/confirm`, { method: 'POST' });
    syncProjectState(payload);
    state.submitPending = false;
    state.view = 'config';
    render();
    showToast('文案已确认，请先确定前期策划配置。');
  } catch (error) {
    state.submitPending = false;
    render();
    showToast(error.message, 'error');
  }
}

function handleAction(element) {
  const action = element.dataset.action;
  switch (action) {
    case 'navigate':
      stopPolling();
      state.view = element.dataset.view || 'dashboard';
      state.modal = null;
      render();
      break;
    case 'open-create':
      stopPolling();
      if (!element.dataset.project) {
        saveSessionProjectId(null);
        state.scriptTaskId = null;
        state.generationTaskId = null;
        state.generationTaskStatus = 'idle';
        state.generationTaskStep = 'queued';
        state.generationProgress = 0;
        state.generationError = null;
        state.generationChildren = [];
        state.generationIdempotencyKey = null;
        state.exportTaskId = null;
        state.exportTaskStatus = 'idle';
        state.exportProgress = 0;
        state.exportError = null;
        state.scriptIdempotencyKey = null;
        state.scriptVersionId = null;
        state.scriptTaskStatus = 'idle';
        state.scriptTaskStep = 'queued';
        state.scriptError = null;
        state.visualBible = null;
        state.storyboardPlan = null;
        state.storyboardTaskId = null;
        state.storyboardTaskStatus = 'idle';
        state.storyboardTaskStep = 'queued';
        state.storyboardProgress = 0;
        state.storyboardError = null;
        state.storyboardIdempotencyKey = null;
        state.planningTab = 'director';
        state.submitPending = false;
        state.segments = state.segments.map(segment => ({ ...segment, id: undefined, revision: 0 }));
      }
      state.view = 'create';
      state.modal = null;
      render();
      break;
    case 'open-editor':
      openEditor();
      break;
    case 'select-genre':
      state.genre = element.dataset.genre;
      document.querySelectorAll('.genre-chip').forEach(chip => chip.classList.toggle('active', chip.dataset.genre === state.genre));
      break;
    case 'start-script':
      void startScriptProcessing();
      break;
    case 'retry-script':
      if (!state.scriptTaskId || state.submitPending) break;
      state.submitPending = true;
      state.scriptError = null;
      state.scriptTaskStatus = 'pending';
      render();
      apiRequest(`/script-tasks/${state.scriptTaskId}/retry`, { method: 'POST' })
        .then(payload => {
          syncProjectState(payload);
          state.submitPending = false;
          state.view = 'script-processing';
          render();
          startPolling(state.scriptTaskId);
        })
        .catch(error => {
          state.submitPending = false;
          state.scriptTaskStatus = 'failed';
          state.scriptError = error.message;
          render();
          showToast(error.message, 'error');
        });
      break;
    case 'select-segment':
      if (state.view === 'editor') {
        state.selectedSegment = Number(element.dataset.index || 0);
        state.editorDirty = false;
        render();
        break;
      }
      clearTimeout(state.segmentSaveTimers.get(state.segments[state.selectedSegment]?.id));
      state.segmentSaveTimers.delete(state.segments[state.selectedSegment]?.id);
      void saveCurrentSegment({ silent: true }).finally(() => {
        state.selectedSegment = Number(element.dataset.index || 0);
        state.draftDirty = false;
        render();
      });
      break;
    case 'save-script':
      void saveCurrentSegment({ force: true });
      break;
    case 'confirm-script':
      void confirmScript();
      break;
    case 'confirm-shots':
      void confirmStoryboardAndGenerate();
      break;
    case 'select-planning-tab':
      state.planningTab = element.dataset.tab || 'director';
      render();
      break;
    case 'regenerate-storyboard':
      void regenerateStoryboardFrom(element.dataset.layer || 'director');
      break;
    case 'select-style':
      state.selectedStyle = element.dataset.style;
      render();
      break;
    case 'select-voice':
      state.selectedVoice = element.dataset.voice;
      render();
      break;
    case 'start-storyboard':
      void startStoryboardPlanning();
      break;
    case 'retry-storyboard':
      if (!state.storyboardTaskId || state.submitPending) break;
      state.submitPending = true;
      state.storyboardError = null;
      render();
      apiRequest(`/storyboard-tasks/${state.storyboardTaskId}/retry`, { method: 'POST' })
        .then(payload => {
          syncProjectState(payload);
          state.submitPending = false;
          startStoryboardPolling(payload.task.id);
          render();
        })
        .catch(error => {
          state.submitPending = false;
          state.storyboardError = error.message;
          render();
          showToast(error.message, 'error');
        });
      break;
    case 'start-video':
      void startGeneration();
      break;
    case 'retry-generation':
      if (!state.generationTaskId) break;
      apiRequest(`/generation-tasks/${state.generationTaskId}/retry`, { method: 'POST' })
        .then(payload => {
          syncProjectState(payload);
          state.generationComplete = false;
          startGenerationPolling(payload.task.id);
          render();
        })
        .catch(error => showToast(error.message, 'error'));
      break;
    case 'preview-full':
      state.playing = !state.playing;
      render();
      break;
    case 'previous-segment':
      state.selectedSegment = Math.max(0, state.selectedSegment - 1);
      render();
      break;
    case 'next-segment':
      state.selectedSegment = Math.min(state.segments.length - 1, state.selectedSegment + 1);
      render();
      break;
    case 'regenerate-segment':
      void regenerateCurrentSegment();
      break;
    case 'open-export':
      state.modal = 'export';
      state.exporting = false;
      state.exportDone = false;
      render();
      break;
    case 'select-ratio':
      state.exportRatio = element.dataset.ratio;
      render();
      break;
    case 'select-resolution':
      state.exportResolution = element.dataset.resolution;
      render();
      break;
    case 'start-export':
      void startExport();
      break;
    case 'download-export':
      showToast('下载链接已准备好（原型演示）。');
      break;
    case 'close-modal':
      if (element.dataset.modalContent !== undefined && element !== document.querySelector('.modal-backdrop')) break;
      state.modal = null;
      state.exporting = false;
      render();
      break;
    case 'notifications':
      showToast('你有 1 条任务完成通知。');
      break;
    case 'show-toast':
      showToast('订阅与客服功能将在接入服务后开放。');
      break;
  }
}

app.addEventListener('click', event => {
  const element = event.target.closest('[data-action]');
  if (!element || !app.contains(element)) return;
  if (element.tagName === 'A') event.preventDefault();
  handleAction(element);
});

document.addEventListener('click', event => {
  const backdrop = event.target.closest('.modal-backdrop');
  if (backdrop && event.target === backdrop) {
    state.modal = null;
    state.exporting = false;
    render();
  }
});

app.addEventListener('input', event => {
  if (event.target.dataset.shotField) {
    const shot = state.segments.flatMap(segment => segment.shots || []).find(item => item.id === event.target.dataset.shotId);
    if (shot) shot[event.target.dataset.shotField] = event.target.type === 'number' ? Number(event.target.value) : event.target.value;
    return;
  }
  if (event.target.dataset.shotId) {
    const segment = state.segments[state.selectedSegment];
    const shot = segment?.shots?.find(item => item.id === event.target.dataset.shotId);
    if (shot) { shot.promptZh = event.target.value; state.editorDirty = true; }
    return;
  }
  if (event.target.dataset.field === 'visualBible') {
    try { state.visualBible = { ...(state.visualBible || {}), content: JSON.parse(event.target.value) }; } catch { /* wait for valid JSON */ }
    return;
  }
  const field = event.target.dataset.field;
  if (!field) return;
  if (field === 'sourceText') {
    state.sourceText = event.target.value;
    updateCreateEstimate();
  }
  if (field === 'projectTitle') {
    state.title = event.target.value;
  }
  if (field === 'scriptText') {
    const segment = state.segments[state.selectedSegment];
    if (!segment) return;
    segment.script = event.target.value;
    state.draftDirty = true;
    if (segment.id) {
      state.segmentSaveStatus.set(segment.id, 'dirty');
      clearTimeout(state.segmentSaveTimers.get(segment.id));
      state.segmentSaveTimers.set(segment.id, setTimeout(() => {
        state.segmentSaveTimers.delete(segment.id);
        void saveCurrentSegment({ silent: true }).then(() => {
          if (state.view !== 'script-preview') return;
          const current = state.segments[state.selectedSegment];
          if (current?.id === segment.id) {
            const currentStatus = document.querySelector('.script-editor-card .save-status');
            if (currentStatus) {
              currentStatus.className = 'save-status';
              currentStatus.textContent = state.segmentSaveStatus.get(segment.id) === 'saved' ? '已自动保存' : '保存失败';
            }
          }
        });
      }, 800));
    }
    const count = document.querySelector('[data-role="script-count"]');
    const status = document.querySelector('.script-editor-card .save-status');
    if (count) count.textContent = Array.from(event.target.value).length;
    if (status) { status.className = 'save-status saving'; status.textContent = '正在保存'; }
  }
  if (field === 'editorScript') {
    state.segments[state.selectedSegment].script = event.target.value;
    state.editorDirty = true;
    const status = document.querySelector('.editor-title-wrap .save-status');
    if (status) { status.className = 'save-status saving'; status.textContent = '保存中'; }
    clearTimeout(state.editorSaveTimer);
    state.editorSaveTimer = setTimeout(() => {
      state.editorDirty = false;
      const current = document.querySelector('.editor-title-wrap .save-status');
      if (current) { current.className = 'save-status'; current.textContent = '已保存'; }
    }, 800);
  }
  if (field === 'promptText') {
    const segment = state.segments[state.selectedSegment];
    if (!segment) return;
    segment.promptText = event.target.value;
    state.editorDirty = true;
  }
});

app.addEventListener('change', event => {
  if (event.target.dataset.shotId) {
    const shotId = event.target.dataset.shotId;
    const shotField = event.target.dataset.shotField;
    if (state.view === 'editor' && !shotField) {
      showToast('镜头修改将在“仅重新生成本段”时创建新版本。');
      return;
    }
    const body = shotField
      ? { [shotField]: event.target.type === 'number' ? Number(event.target.value) : event.target.value }
      : { promptZh: event.target.value };
    apiRequest(shotField ? `/shots/${shotId}` : `/shots/${shotId}/prompt`, { method: 'PATCH', body: JSON.stringify(body) })
      .then(payload => {
        const shot = state.segments.flatMap(segment => segment.shots || []).find(item => item.id === shotId);
        if (shot && payload.shot) Object.assign(shot, payload.shot);
        showToast(shotField ? '分镜字段已保存，执行提示词已同步更新。' : '中文镜头提示词已保存。');
      })
      .catch(error => showToast(error.message, 'error'));
    return;
  }
  const field = event.target.dataset.field;
  if (field === 'copyrightConfirmed') state.copyrightConfirmed = event.target.checked;
  if (field === 'editorVoice') {
    const segment = state.segments[state.selectedSegment];
    if (!segment) return;
    segment.voiceId = event.target.value;
    state.editorDirty = true;
    render();
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.modal) {
    state.modal = null;
    state.exporting = false;
    render();
  }
});

window.addEventListener('pagehide', () => {
  stopPolling();
  void flushSegmentDrafts();
});

render();
void restoreSession();

