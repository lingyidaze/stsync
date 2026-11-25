// SPDX-License-Identifier: AGPL-3.0-only
const USER = 'data/default-user';
const user = (...names) => names.map((n) => `${USER}/${n}`);

export const CATEGORIES = [
    { id: 'characters', label: '角色卡', dirs: user('characters') },
    { id: 'chats', label: '聊天记录', dirs: user('chats', 'group chats') },
    { id: 'groups', label: '群组', dirs: user('groups') },
    { id: 'personas', label: '用户角色', dirs: user('User Avatars') },
    { id: 'worlds', label: '世界书', dirs: user('worlds') },
    {
        id: 'presets', label: '预设与提示词模板',
        dirs: user('OpenAI Settings', 'TextGen Settings', 'KoboldAI Settings', 'NovelAI Settings', 'instruct', 'context', 'sysprompt', 'reasoning'),
    },
    { id: 'quick-replies', label: '快速回复', dirs: user('QuickReplies') },
    { id: 'appearance', label: '外观', dirs: user('themes', 'backgrounds', 'movingUI') },
    { id: 'media', label: '媒体与用户文件', dirs: user('assets', 'user/images', 'user/files', 'user/workflows') },
    { id: 'extensions', label: '扩展', dirs: [...user('extensions'), 'public/scripts/extensions/third-party'] },
    { id: 'luker', label: 'Luker 专属', dirs: user('card-apps', 'skills') },
    { id: 'vectors', label: '向量库', dirs: user('vectors') },
    { id: 'backups', label: '备份', dirs: user('backups') },
    {
        id: 'settings', label: '设置', files: user('settings.json', 'image-metadata.json'),
        mergeInputs: user('settings/appearance.json', 'settings/layout.json', 'settings/presets.json', 'settings/persona-state.json'),
    },
    { id: 'secrets', label: 'API 密钥', files: user('secrets.json') },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

const TEMP_SUFFIXES = ['.stsync.tmp', '.ttsync.tmp'];
const IGNORED_DIRS = new Set(['.git', 'node_modules']);
const SELF_DIRS = [`${USER}/extensions/stsync`, 'public/scripts/extensions/third-party/stsync'];

export function isIgnored(p) {
    const name = p.slice(p.lastIndexOf('/') + 1);
    if (TEMP_SUFFIXES.some((s) => name.endsWith(s))) return true;
    if (p.split('/').some((segment) => IGNORED_DIRS.has(segment))) return true;
    return SELF_DIRS.some((d) => p === d || p.startsWith(`${d}/`));
}

const SIDECAR = /^(.*)\.luker-state\.[^/]+\.json$/;

export function sidecarOwner(p) {
    const match = SIDECAR.exec(p);
    return match ? `${match[1]}.jsonl` : null;
}

const BAD_CHARS = /[\u0000-\u001f\\]/;

export function validatePath(p) {
    if (typeof p !== 'string' || !p || p.length > 4096 || p.startsWith('/') || BAD_CHARS.test(p)) {
        throw new TypeError(`非法路径：${JSON.stringify(p)}`);
    }
    for (const segment of p.split('/')) {
        if (!segment || segment === '.' || segment === '..') throw new TypeError(`非法路径：${JSON.stringify(p)}`);
    }
    return p;
}

export function resolveScope(ids) {
    if (!Array.isArray(ids) || ids.length === 0) throw new TypeError('至少选择一个数据类别');
    const selected = [];
    for (const id of ids) {
        const category = BY_ID.get(id);
        if (category && !selected.includes(category)) selected.push(category);
    }
    if (selected.length === 0) throw new TypeError(`未知数据类别：${ids.join(', ')}`);
    const dirs = selected.flatMap((c) => c.dirs || []);
    const files = new Set(selected.flatMap((c) => c.files || []));
    const mergeInputs = new Set(selected.flatMap((c) => c.mergeInputs || []));
    const inDir = (p) => dirs.some((d) => p.startsWith(`${d}/`));
    return {
        categories: selected.map((c) => c.id),
        dirs,
        files: [...files],
        mergeInputs: [...mergeInputs],
        contains: (p) => !isIgnored(p) && (files.has(p) || inDir(p)),
        isMergeInput: (p) => mergeInputs.has(p),
    };
}
