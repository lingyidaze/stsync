// SPDX-License-Identifier: AGPL-3.0-only
import * as api from './api.js';

const MODULE_ID = 'stsync';
const BOOT_FLAG = Symbol.for('stsync.booted');

let settings = null;
let host = null;
let hostReady = false;
let setupNeeded = false;
let backend = { state: 'pending', title: '正在检测…', detail: '' };
let servers = [];
let busy = false;
let editing = false;
let clockTimer = null;
const $root = () => document.getElementById('stsync-settings');
const $ = (sel) => $root()?.querySelector(sel);

function getContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

function loadSettings() {
    const store = getContext()?.extensionSettings;
    const current = store?.[MODULE_ID] ?? {};
    settings = {
        serverUrl: typeof current.serverUrl === 'string' ? current.serverUrl : '',
        serverDeviceId: typeof current.serverDeviceId === 'string' ? current.serverDeviceId : '',
        mode: current.mode === api.MODES.MIRROR ? api.MODES.MIRROR : api.MODES.INCREMENTAL,
    };
    if (store) store[MODULE_ID] = settings;
}

function saveSettings() {
    const ctx = getContext();
    if (ctx?.extensionSettings) ctx.extensionSettings[MODULE_ID] = settings;
    ctx?.saveSettingsDebounced?.();
}

async function confirmDialog(title, message) {
    const ctx = getContext();
    if (typeof ctx?.callGenericPopup === 'function' && ctx?.POPUP_TYPE) {
        const content = document.createElement('div');
        const heading = document.createElement('h3');
        heading.textContent = title;
        const body = document.createElement('div');
        body.style.whiteSpace = 'pre-wrap';
        body.style.textAlign = 'left';
        body.textContent = message;
        content.append(heading, body);
        const result = await ctx.callGenericPopup(content, ctx.POPUP_TYPE.CONFIRM, '', {
            okButton: '确定',
            cancelButton: '取消',
        });
        return result === (ctx.POPUP_RESULT?.AFFIRMATIVE ?? 1);
    }
    return window.confirm(`${title}\n\n${message}`);
}

function toast(type, message, title = 'STSync') {
    const fn = window.toastr?.[type];
    if (typeof fn === 'function') fn(message, title);
    else console.log(`[STSync] ${title}: ${message}`);
}

function formatBytes(n) {
    const value = Number(n) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} 秒`;
    if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
    return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

function relativeTime(ms) {
    if (!ms) return '从未同步';
    const diff = Date.now() - ms;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
    return new Date(ms).toLocaleDateString();
}

function errorText(error) {
    if (!error) return '未知错误';
    if (typeof error === 'string') return error;
    return error.message || error.detail || JSON.stringify(error);
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function settingsHtml() {
    return `
<div id="stsync-settings" class="stsync">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>STSync 云同步</b>
      <span class="stsync-badge" data-role="badge"></span>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content"><div class="stsync-body">

      <div class="stsync-card stsync-backend" data-role="backend">
        <div class="stsync-backend-head">
          <span class="stsync-dot" data-role="backend-dot"></span>
          <div class="stsync-grow">
            <div class="stsync-muted stsync-backend-label">后端检测</div>
            <div class="stsync-backend-title" data-role="backend-title"></div>
          </div>
          <div class="menu_button menu_button_icon" data-action="recheck" title="重新检测"><i class="fa-solid fa-rotate"></i><span>重新检测</span></div>
        </div>
        <div class="stsync-muted" data-role="backend-detail"></div>
        <div class="stsync-backend-fix" data-role="backend-fix" hidden>
          <div class="stsync-muted">复制对应的命令运行，完成后重启 SillyTavern，再点「重新检测」。</div>
          <div data-role="setup-commands"></div>
        </div>
      </div>

      <div class="stsync-card stsync-server" data-role="connected" hidden>
        <div class="stsync-server-main">
          <span class="stsync-dot"></span>
          <div class="stsync-grow">
            <div class="stsync-server-name" data-role="server-name"></div>
            <div class="stsync-muted stsync-ellipsis" data-role="server-url"></div>
          </div>
        </div>
        <div class="stsync-server-foot">
          <span class="stsync-muted" data-role="last-sync"></span>
          <div class="stsync-inline-actions">
            <div class="menu_button menu_button_icon" data-action="edit" title="修改服务器地址或 API Key"><i class="fa-solid fa-pen"></i><span>修改</span></div>
            <div class="menu_button menu_button_icon" data-action="disconnect" title="断开与这台服务器的连接"><i class="fa-solid fa-link-slash"></i><span>断开</span></div>
          </div>
        </div>
      </div>

      <div class="stsync-card" data-role="form" hidden>
        <div class="stsync-card-title"><i class="fa-solid fa-server"></i> 连接服务器</div>
        <label class="stsync-field">
          <span>服务器地址</span>
          <input type="text" class="text_pole" data-role="url-input" spellcheck="false" autocomplete="off" inputmode="url"
                 placeholder="https://服务器IP:8443" />
        </label>
        <label class="stsync-field">
          <span>API Key</span>
          <input type="password" class="text_pole" data-role="key-input" spellcheck="false" autocomplete="off"
                 placeholder="sts1.…" />
        </label>
        <div class="stsync-muted">两项都在服务器上运行 <code>stsync key</code> 查看。</div>
        <div class="stsync-inline-actions">
          <div class="menu_button menu_button_icon" data-action="save"><i class="fa-solid fa-plug"></i><span>连接</span></div>
          <div class="menu_button menu_button_icon" data-action="cancel" hidden><span>取消</span></div>
        </div>
      </div>

      <div class="stsync-card" data-role="sync">
        <div class="stsync-segment" role="radiogroup" aria-label="同步模式">
          <div class="stsync-segment-item" role="radio" tabindex="0" data-mode="Incremental">
            <i class="fa-solid fa-layer-group"></i><span>增量</span>
          </div>
          <div class="stsync-segment-item" role="radio" tabindex="0" data-mode="Mirror">
            <i class="fa-solid fa-clone"></i><span>镜像</span>
          </div>
        </div>
        <div class="stsync-muted" data-role="mode-hint"></div>
        <div class="stsync-main-actions">
          <div class="menu_button stsync-big" data-action="upload"><i class="fa-solid fa-cloud-arrow-up"></i><span>上传到云端</span></div>
          <div class="menu_button stsync-big" data-action="download"><i class="fa-solid fa-cloud-arrow-down"></i><span>从云端下载</span></div>
        </div>

        <div class="stsync-progress" data-role="progress" hidden>
          <div class="stsync-progress-head">
            <span data-role="progress-label"></span>
            <span data-role="progress-percent"></span>
          </div>
          <div class="stsync-bar"><div class="stsync-bar-fill" data-role="progress-fill"></div></div>
          <div class="stsync-muted" data-role="progress-detail"></div>
          <div class="stsync-muted stsync-ellipsis" data-role="progress-current"></div>
        </div>

        <div class="stsync-result" data-role="result" hidden>
          <div class="stsync-result-title" data-role="result-title"></div>
          <div class="stsync-result-stats" data-role="result-stats"></div>
          <div class="stsync-skipped" data-role="result-skipped" hidden></div>
          <details data-role="result-warnings" hidden>
            <summary></summary>
            <ul></ul>
          </details>
          <div class="stsync-inline-actions" data-role="result-actions"></div>
        </div>
      </div>

    </div></div>
  </div>
</div>`;
}

function mountUI() {
    const container = document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings');
    if (!container) throw new Error('未找到扩展设置容器 #extensions_settings');
    container.insertAdjacentHTML('beforeend', settingsHtml());

    $('[data-role="url-input"]').value = settings.serverUrl;
    for (const item of $root().querySelectorAll('[data-mode]')) {
        const choose = () => {
            if (busy || settings.mode === item.dataset.mode) return;
            settings.mode = item.dataset.mode;
            saveSettings();
            render();
        };
        item.addEventListener('click', choose);
        item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                choose();
            }
        });
    }
    $('[data-role="key-input"]').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') doSave();
    });
    $root().addEventListener('click', onClick);
    clockTimer = setInterval(renderLastSync, 60_000);
}

function renderBackend() {
    const dot = $('[data-role="backend-dot"]');
    dot.className = `stsync-dot stsync-dot-${backend.state}`;
    $('[data-role="backend-title"]').textContent = backend.title;
    const detail = $('[data-role="backend-detail"]');
    detail.textContent = backend.detail || '';
    detail.hidden = !backend.detail;
    const commands = backend.commands || [];
    $('[data-role="backend-fix"]').hidden = commands.length === 0;
    const list = $('[data-role="setup-commands"]');
    list.innerHTML = commands.map((c, i) => `
        <div class="stsync-command">
          <div class="stsync-muted">${escapeHtml(c.label)}</div>
          <div class="stsync-command-row">
            <code>${escapeHtml(c.command)}</code>
            <div class="menu_button menu_button_icon" data-action="copy" data-index="${i}" title="复制"><i class="fa-solid fa-copy"></i></div>
          </div>
        </div>`).join('');
}

function currentServer() {
    return servers.find((s) => s.id === settings.serverDeviceId) || null;
}

function renderLastSync() {
    const server = currentServer();
    const el = $('[data-role="last-sync"]');
    if (!el || !server) return;
    el.textContent = `上次同步：${relativeTime(server.lastSync)}`;
    el.title = server.lastSync ? new Date(server.lastSync).toLocaleString() : '';
}

function render() {
    const server = currentServer();
    const showForm = !setupNeeded && (editing || !server);
    renderBackend();
    $('[data-role="form"]').hidden = !showForm;
    $('[data-role="connected"]').hidden = setupNeeded || showForm;
    $('[data-role="sync"]').hidden = setupNeeded;
    $('[data-action="cancel"]').hidden = !server;

    const badge = $('[data-role="badge"]');
    badge.className = 'stsync-badge';
    if (busy) {
        badge.textContent = '同步中';
        badge.classList.add('stsync-badge-busy');
    } else if (server) {
        badge.textContent = '已连接';
        badge.classList.add('stsync-badge-ok');
    } else {
        badge.textContent = setupNeeded ? '后端异常' : '未连接';
    }

    if (server) {
        $('[data-role="server-name"]').textContent = server.name || 'STSync 服务器';
        $('[data-role="server-url"]').textContent = server.url;
        renderLastSync();
    }

    const mirror = settings.mode === api.MODES.MIRROR;
    for (const item of $root().querySelectorAll('[data-mode]')) {
        const active = item.dataset.mode === settings.mode;
        item.classList.toggle('active', active);
        item.classList.toggle('danger', active && mirror);
        item.setAttribute('aria-checked', String(active));
        item.classList.toggle('disabled', busy);
    }
    const hint = $('[data-role="mode-hint"]');
    hint.textContent = mirror
        ? '镜像：目标端与源端完全一致，目标端多出的文件会被删除'
        : '增量：只新增和更新文件，不删除任何文件';
    hint.classList.toggle('stsync-danger', mirror);

    for (const el of $root().querySelectorAll('[data-action]')) {
        const action = el.dataset.action;
        let disabled = busy && action !== 'copy';
        if (action === 'upload' || action === 'download') disabled ||= !server || !hostReady;
        if (action === 'save') disabled ||= !hostReady;
        el.classList.toggle('disabled', disabled);
        el.setAttribute('aria-disabled', String(disabled));
    }
}

const SKIP_REASONS = {
    'remote-newer': '云端较新',
    'local-newer': '本机较新',
    conflict: '两边都改过',
};

const RESULT_ACTIONS = {
    'force-push': '<i class="fa-solid fa-cloud-arrow-up"></i><span>以本机为准强制上传</span>',
    'force-pull': '<i class="fa-solid fa-cloud-arrow-down"></i><span>以云端为准强制下载</span>',
    reload: '<i class="fa-solid fa-rotate-right"></i><span>刷新页面载入新数据</span>',
};

function renderSkipped(skipped, isPush) {
    const box = $('[data-role="result-skipped"]');
    box.hidden = skipped.length === 0;
    if (!skipped.length) return;
    const counts = {};
    for (const s of skipped) counts[s.reason] = (counts[s.reason] || 0) + 1;
    const summary = Object.entries(counts).map(([r, n]) => `${SKIP_REASONS[r] || r} ${n} 个`).join('，');
    const hint = isPush
        ? '这些文件没有上传，以免覆盖云端较新的内容。通常先「从云端下载」即可；确认要用本机版本覆盖时再强制上传。'
        : '这些文件没有下载，以免覆盖本机较新的内容。通常先「上传到云端」即可；确认要用云端版本覆盖时再强制下载。';
    box.innerHTML = `
        <div class="stsync-skipped-title"><i class="fa-solid fa-triangle-exclamation"></i> 已跳过 ${skipped.length} 个文件（${escapeHtml(summary)}）</div>
        <div class="stsync-muted">${escapeHtml(hint)}</div>
        <details><summary>查看文件</summary><ul>${skipped.slice(0, 200)
        .map((s) => `<li><span class="stsync-muted">[${escapeHtml(SKIP_REASONS[s.reason] || s.reason)}]</span> ${escapeHtml(s.path.replace(/^data\/default-user\//, ''))}</li>`)
        .join('')}${skipped.length > 200 ? `<li>…还有 ${skipped.length - 200} 个</li>` : ''}</ul></details>`;
}

function showResult(tone, title, stats = [], warnings = [], { skipped = [], isPush = true, actions = [] } = {}) {
    const box = $('[data-role="result"]');
    box.hidden = false;
    box.className = `stsync-result stsync-result-${tone}`;
    const icon = { ok: 'fa-circle-check', danger: 'fa-circle-xmark', info: 'fa-circle-info', warn: 'fa-triangle-exclamation' }[tone] || 'fa-circle-info';
    $('[data-role="result-title"]').innerHTML = `<i class="fa-solid ${icon}"></i> ${escapeHtml(title)}`;
    $('[data-role="result-stats"]').innerHTML = stats
        .map(([k, v]) => `<div><span class="stsync-muted">${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('');
    const details = $('[data-role="result-warnings"]');
    details.hidden = warnings.length === 0;
    details.querySelector('summary').textContent = `${warnings.length} 条提醒`;
    details.querySelector('ul').innerHTML = warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
    renderSkipped(skipped, isPush);
    $('[data-role="result-actions"]').innerHTML = actions
        .map((a) => `<div class="menu_button menu_button_icon" data-action="${a}">${RESULT_ACTIONS[a]}</div>`).join('');
}

function hideResult() {
    $('[data-role="result"]').hidden = true;
}

function createProgressView(verb) {
    const box = $('[data-role="progress"]');
    const fill = $('[data-role="progress-fill"]');
    let last = null;
    let speed = 0;
    box.hidden = false;
    hideResult();

    const update = (p) => {
        const known = p.total > 0;
        const ratio = known ? Math.min(1, p.done / p.total) : 0;
        $('[data-role="progress-label"]').textContent = p.label || `正在${verb}…`;
        $('[data-role="progress-percent"]').textContent = known ? `${Math.floor(ratio * 100)}%` : '';
        box.classList.toggle('indeterminate', !known);
        fill.style.width = known ? `${(ratio * 100).toFixed(1)}%` : '';

        let detail = '';
        if (p.unit === 'bytes') {
            const now = performance.now();
            if (last && last.phase === p.phase && now > last.t) {
                const instant = Math.max(0, (p.done - last.done) / ((now - last.t) / 1000));
                speed = speed ? speed * 0.7 + instant * 0.3 : instant;
            } else {
                speed = 0;
            }
            last = { phase: p.phase, t: now, done: p.done };
            detail = `${formatBytes(p.done)} / ${formatBytes(p.total)}`;
            if (speed > 0) {
                detail += ` · ${formatBytes(speed)}/s`;
                detail += ` · 剩余约 ${formatDuration(((p.total - p.done) / speed) * 1000)}`;
            }
        } else if (p.unit === 'files') {
            last = null;
            detail = `${p.done} / ${p.total} 个文件`;
        }
        $('[data-role="progress-detail"]').textContent = detail;
        $('[data-role="progress-current"]').textContent = p.current || '';
    };

    update({ label: `正在${verb}…`, done: 0, total: 0 });
    return {
        update,
        close() {
            box.hidden = true;
        },
    };
}

async function refresh() {
    backend = await host.checkBackend().catch((error) => ({ state: 'error', title: '后端检测失败', detail: errorText(error) }));
    hostReady = ['ok', 'outdated', 'unknown'].includes(backend.state);
    setupNeeded = !hostReady;
    if (setupNeeded) {
        servers = [];
        render();
        return;
    }
    try {
        servers = await host.listServers();
        if (!currentServer() && servers.length === 1) {
            settings.serverDeviceId = servers[0].id;
            saveSettings();
        }
    } catch (error) {
        servers = [];
        showResult('danger', errorText(error));
    }
    render();
}

async function withBusy(fn) {
    if (busy) return;
    busy = true;
    render();
    try {
        await fn();
    } finally {
        busy = false;
        render();
    }
}

async function onClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target || target.classList.contains('disabled')) return;
    switch (target.dataset.action) {
        case 'save': return doSave();
        case 'edit':
            editing = true;
            $('[data-role="url-input"]').value = currentServer()?.url || settings.serverUrl;
            return render();
        case 'cancel':
            editing = false;
            $('[data-role="key-input"]').value = '';
            return render();
        case 'disconnect': return doDisconnect();
        case 'recheck': return doRecheck();
        case 'copy': return doCopy(Number(target.dataset.index));
        case 'upload': return doSync(true);
        case 'download': return doSync(false);
        case 'force-push': return doSync(true, true);
        case 'force-pull': return doSync(false, true);
        case 'reload': return window.location.reload();
    }
}

async function doCopy(index) {
    const command = backend.commands?.[index]?.command;
    if (!command) return;
    try {
        await navigator.clipboard.writeText(command);
        toast('success', '已复制到剪贴板');
    } catch {
        window.prompt('复制下面的命令：', command);
    }
}

async function doSave() {
    const urlInput = $('[data-role="url-input"]');
    const keyInput = $('[data-role="key-input"]');
    await withBusy(async () => {
        try {
            const serverUrl = api.normalizeServerUrl(urlInput.value);
            const { id } = await host.pair(serverUrl, keyInput.value);
            const previous = settings.serverDeviceId;
            if (previous && previous !== id && servers.some((s) => s.id === previous)) {
                await host.removeServer(previous).catch(() => {});
            }
            keyInput.value = '';
            settings.serverUrl = serverUrl;
            settings.serverDeviceId = id;
            saveSettings();
            editing = false;
            showResult('ok', '已连接服务器');
        } catch (error) {
            showResult('danger', `连接失败：${errorText(error)}`);
        }
    });
    await refresh();
}

async function doRecheck() {
    backend = { state: 'pending', title: '正在检测…', detail: '' };
    render();
    await refresh();
    toast(hostReady ? 'success' : 'warning', backend.title, '后端检测');
}

async function doDisconnect() {
    const server = currentServer();
    if (!server) return;
    const ok = await confirmDialog('断开服务器', `断开与 ${server.url} 的连接？\n云端数据不会被删除，之后可以用 API Key 重新连接。`);
    if (!ok) return;
    await withBusy(async () => {
        try {
            await host.removeServer(server.id);
            settings.serverDeviceId = '';
            saveSettings();
            showResult('info', '已断开连接');
        } catch (error) {
            showResult('danger', `断开失败：${errorText(error)}`);
        }
    });
    await refresh();
}

async function doSync(isPush, force = false) {
    const server = currentServer();
    if (!server || !hostReady) return;

    if (force) {
        const ok = await confirmDialog(
            isPush ? '强制上传' : '强制下载',
            isPush
                ? '被跳过的文件将用本机版本覆盖云端版本（包括云端较新的内容）。确定继续？'
                : '被跳过的文件将用云端版本覆盖本机版本（包括本机较新的内容）。被覆盖的本机文件会先备份，保留 7 天。确定继续？',
        );
        if (!ok) return;
    } else if (settings.mode === api.MODES.MIRROR) {
        const ok = await confirmDialog(
            isPush ? '镜像上传' : '镜像下载',
            isPush
                ? '云端将与本地完全一致，云端多出的文件会被删除。确定继续？'
                : '本地将与云端完全一致，本地多出的文件会被删除。确定继续？',
        );
        if (!ok) return;
    }

    const verb = isPush ? '上传' : '下载';
    const direction = isPush ? 'push' : 'pull';
    const started = Date.now();
    await withBusy(async () => {
        const view = createProgressView(verb);
        let result = null;
        try {
            result = await host.sync(direction, server.id, settings.mode, (p) => view.update(p), { force });
            view.close();
            if (result.status === 'failed') {
                showResult('danger', `${verb}失败：${result.message || '未知错误'}`);
                toast('error', result.message || '未知错误', `${verb}失败`);
            } else {
                const s = result.summary || {};
                const stats = [];
                if (typeof s.files === 'number') stats.push([isPush ? '上传文件' : '下载文件', `${s.files} 个`]);
                if (typeof s.sent === 'number') stats.push(['实际传输', formatBytes(s.sent)]);
                if (typeof s.bytes === 'number' && s.bytes > 0) stats.push(['文件总量', formatBytes(s.bytes)]);
                if (typeof s.deleted === 'number' && s.deleted > 0) stats.push(['删除文件', `${s.deleted} 个`]);
                if (typeof s.backedUp === 'number' && s.backedUp > 0) stats.push(['已备份本机旧文件', `${s.backedUp} 个`]);
                stats.push(['用时', formatDuration(Date.now() - started)]);
                const skipped = Array.isArray(s.skipped) ? s.skipped : [];
                const nothing = s.files === 0 && !s.deleted;
                const changed = !isPush && !nothing;
                const actions = [];
                if (skipped.length) actions.push(isPush ? 'force-push' : 'force-pull');
                if (changed && skipped.length) actions.push('reload');
                const title = nothing && !skipped.length ? `已是最新，无需${verb}` : `${verb}完成`;
                showResult(skipped.length ? 'warn' : 'ok', title, stats, result.warnings || [], { skipped, isPush, actions });
            }
        } catch (error) {
            view.close();
            showResult('danger', `${verb}失败：${errorText(error)}`);
            toast('error', errorText(error), `${verb}失败`);
        }

        if (result) {
            await host.afterSync(direction, result);
        }
    });
    await refresh();
}

async function boot() {
    if (window[BOOT_FLAG]) return;
    window[BOOT_FLAG] = true;

    try {
        host = await api.loadHost();
    } catch (error) {
        console.error('[STSync] 加载宿主适配失败', error);
        return;
    }

    loadSettings();
    try {
        mountUI();
    } catch (error) {
        console.error('[STSync] 挂载设置面板失败', error);
        if (clockTimer) clearInterval(clockTimer);
        return;
    }
    await refresh();
}

export async function activate() {
    return boot();
}

boot();
