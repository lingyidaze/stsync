#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function isSillyTavernRoot(dir) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        return pkg.name === 'sillytavern' && fs.existsSync(path.join(dir, 'server.js'));
    } catch {
        return false;
    }
}

function ancestors(start) {
    const list = [];
    let dir = path.resolve(start);
    for (;;) {
        list.push(dir);
        const parent = path.dirname(dir);
        if (parent === dir) return list;
        dir = parent;
    }
}

function childDirs(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
            .map((e) => path.join(dir, e.name));
    } catch {
        return [];
    }
}

function findRoot() {
    if (process.argv[2]) {
        const dir = path.resolve(process.argv[2]);
        return isSillyTavernRoot(dir) ? dir : null;
    }
    const home = os.homedir();
    const levelOne = childDirs(home);
    const candidates = [
        ...ancestors(here),
        ...ancestors(process.cwd()),
        ...levelOne,
        ...levelOne.flatMap(childDirs),
    ];
    return candidates.find(isSillyTavernRoot) ?? null;
}

const root = findRoot();
if (!root) {
    console.error('✗ 没有找到 SillyTavern。请把 SillyTavern 文件夹路径写在命令后面，例如：');
    console.error(`  node ${path.relative(process.cwd(), fileURLToPath(import.meta.url)) || 'install.mjs'} ~/SillyTavern`);
    process.exit(1);
}

const target = path.join(root, 'plugins', 'stsync');
const pluginFile = path.join(here, 'index.mjs');
const relative = path.relative(target, pluginFile);
const entry = path.isAbsolute(relative) ? pathToFileURL(pluginFile).href : relative.split(path.sep).join('/');
const files = {
    'package.json': `${JSON.stringify({ name: 'stsync', private: true, type: 'module', main: 'index.mjs' }, null, 2)}\n`,
    'index.mjs': `export * from '${entry}';\nexport { default } from '${entry}';\n`,
};
const readOr = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const present = fs.existsSync(target) ? fs.readdirSync(target).sort().join('/') : '';
const same = present === Object.keys(files).sort().join('/')
    && Object.entries(files).every(([name, text]) => readOr(path.join(target, name)) === text);
if (same) {
    console.log(`✓ 服务端插件已安装（${target}），跳过`);
} else {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(target, name), text);
    console.log(`✓ 服务端插件已安装：${target}`);
}

const configFile = path.join(root, 'config.yaml');
if (fs.existsSync(configFile)) {
    const text = fs.readFileSync(configFile, 'utf8');
    if (/^enableServerPlugins:\s*true\s*$/m.test(text)) {
        console.log('✓ 服务端插件功能已经是开启状态，跳过');
    } else {
        const backup = `${configFile}.bak-stsync`;
        if (!fs.existsSync(backup)) fs.copyFileSync(configFile, backup);
        const updated = /^enableServerPlugins:.*$/m.test(text)
            ? text.replace(/^enableServerPlugins:.*$/m, 'enableServerPlugins: true')
            : `${text.replace(/\s*$/, '')}\nenableServerPlugins: true\n`;
        fs.writeFileSync(configFile, updated);
        console.log(`✓ 已在 config.yaml 中开启服务端插件（原文件备份为 ${path.basename(backup)}）`);
    }
} else {
    console.log('! 没有找到 config.yaml：请先启动一次 SillyTavern 生成配置文件，再重新运行本命令');
}

console.log('\n完成！重启 SillyTavern 后，在扩展页打开 STSync 填写服务器地址和 API Key。');
console.log('以后在扩展页更新 STSync 时，服务端插件会一起更新（重启 SillyTavern 后生效）。');
