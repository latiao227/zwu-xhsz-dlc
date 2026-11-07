#!/usr/bin/env node
// 智慧思政 DLC 安装器。
//
// 干四件事，全部幂等（重复跑不会重复插）：
//   1. 把 src/*.ts 复制进主仓 src/series/
//   2. src/series/all.ts 追加一行 import './xhsz-tools';
//   3. src/main.ts 注入 token 桥（在智慧思政页面只同步 token，不挂面板）
//   4. scripts/build.mjs 的 userscript 头里加 @match https://nxg.zwu.edu.cn/zhxg/*
//
// 用法：
//   node install.mjs             # 安装
//   node install.mjs --uninstall # 回滚（删文件 + 撤掉自动插入的行）
//   node install.mjs --check     # 只检查当前状态，不改任何文件
//
// 装完跑：npm run build
import {readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, rmSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');           // dlc/xhsz → 仓库根
const srcDir = join(repo, 'src');
const seriesDir = join(srcDir, 'series');

const FILES = [
  'xhsz-token.ts',
  'xhsz-api.ts',
  'xhsz-leave.ts',
  'xhsz-lessons.ts',
  'xhsz-guide.ts',
  'xhsz-form.ts',
  'xhsz-render.ts',
  'xhsz-tools.ts'
];
const mode = process.argv.includes('--uninstall') ? 'uninstall'
  : process.argv.includes('--check') ? 'check' : 'install';

const log = (...args) => console.log(...args);
const ok = (cond, msg) => { if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; return false; } return true; };

// ---------- 0. 前置检查 ----------
if (!existsSync(join(repo, 'package.json'))) {
  console.error(`✗ 找不到主仓：${repo}。请把 dlc/xhsz 放在仓库根下的 dlc/ 里。`);
  process.exit(1);
}
if (!existsSync(seriesDir)) {
  console.error(`✗ 主仓缺 src/series/：${seriesDir}。这看起来不是「我的万里」仓库。`);
  process.exit(1);
}

// ---------- 1. 复制源码 ----------
const copied = [];
for (const file of FILES) {
  const from = join(here, 'src', file);
  const to = join(seriesDir, file);
  if (!existsSync(from)) { console.error(`✗ 缺源文件 ${from}`); process.exit(1); }
  if (mode === 'uninstall') {
    if (existsSync(to)) { rmSync(to); log(`已删除 src/series/${file}`); }
    continue;
  }
  if (mode === 'check') {
    log(`${existsSync(to) ? '✓' : '·'} src/series/${file}`);
    continue;
  }
  copyFileSync(from, to);
  copied.push(file);
}
if (mode === 'install') log(`✓ 复制 ${copied.length} 个文件到 src/series/`);

// ---------- 2. all.ts 注册 ----------
const allPath = join(seriesDir, 'all.ts');
if (existsSync(allPath)) {
  const text = readFileSync(allPath, 'utf8');
  const marker = "import './xhsz-tools';";
  const has = text.includes(marker);
  if (mode === 'uninstall') {
    if (has) {
      writeFileSync(allPath, text.replace(`\n${marker}`, ''), 'utf8');
      log('✓ 已从 all.ts 移除注册');
    }
  } else if (mode === 'check') {
    log(`${has ? '✓' : '·'} all.ts 注册`);
  } else if (!has) {
    const lines = text.split('\n');
    const lastImport = lines.reduce((acc, line, i) => (line.startsWith('import ') ? i : acc), -1);
    lines.splice(lastImport + 1, 0, marker);
    writeFileSync(allPath, lines.join('\n'), 'utf8');
    log('✓ all.ts 已注册');
  } else {
    log('· all.ts 已注册过，跳过');
  }
}

// ---------- 3. main.ts token 桥 ----------
const mainPath = join(srcDir, 'main.ts');
const MAIN_IMPORT = "import {onNxgPage,syncTokenFromPage} from './series/xhsz-token';";
const MAIN_HOOK = "  // DLC: xhsz —— 智慧思政页面只同步 token，不挂面板\n  if(onNxgPage()){syncTokenFromPage();setInterval(syncTokenFromPage,5000);return;}";
if (existsSync(mainPath)) {
  let text = readFileSync(mainPath, 'utf8');
  const hasImport = text.includes(MAIN_IMPORT);
  const hasHook = text.includes(MAIN_HOOK.trim());
  if (mode === 'uninstall') {
    if (hasHook) text = text.replace(new RegExp(`\\n?${escape(MAIN_HOOK)}`), '');
    if (hasImport) text = text.replace(`\n${MAIN_IMPORT}`, '');
    writeFileSync(mainPath, text, 'utf8');
    log('✓ main.ts 已还原');
  } else if (mode === 'check') {
    log(`${hasImport && hasHook ? '✓' : '·'} main.ts token 桥`);
  } else {
    let changed = false;
    if (!hasImport) {
      const lines = text.split('\n');
      const lastImport = lines.reduce((acc, line, i) => (line.startsWith('import ') ? i : acc), -1);
      lines.splice(lastImport + 1, 0, MAIN_IMPORT);
      text = lines.join('\n');
      changed = true;
    }
    if (!hasHook) {
      const anchor = 'function start(){';
      const at = text.indexOf(anchor);
      if (at < 0) { console.error('✗ main.ts 里找不到 function start(){ —— 版本可能变了，手动加也行（见 README）'); }
      else {
        text = text.slice(0, at + anchor.length) + '\n' + MAIN_HOOK + text.slice(at + anchor.length);
        changed = true;
      }
    }
    if (changed) { writeFileSync(mainPath, text, 'utf8'); log('✓ main.ts 已注入 token 桥'); }
    else log('· main.ts 已经注入过，跳过');
  }
}

// ---------- 4. userscript @match ----------
const buildPath = join(repo, 'scripts', 'build.mjs');
const MATCH_LINE = '// @match        https://nxg.zwu.edu.cn/zhxg/*';
if (existsSync(buildPath)) {
  const text = readFileSync(buildPath, 'utf8');
  const has = text.includes(MATCH_LINE);
  if (mode === 'uninstall') {
    if (has) {
      writeFileSync(buildPath, text.replace(`\n${MATCH_LINE}`, ''), 'utf8');
      log('✓ build.mjs 已移除 @match');
    }
  } else if (mode === 'check') {
    log(`${has ? '✓' : '·'} build.mjs @match`);
  } else if (!has) {
    const anchor = '// @match        https://ehallapp.zwu.edu.cn/*';
    if (text.includes(anchor)) {
      writeFileSync(buildPath, text.replace(anchor, `${anchor}\n${MATCH_LINE}`), 'utf8');
      log('✓ build.mjs 已加 @match（智慧思政域）');
    } else {
      console.error('✗ build.mjs 里找不到 ehallapp 的 @match 锚点，手动加一行也行（见 README）');
    }
  } else {
    log('· build.mjs @match 已存在，跳过');
  }
}

// ---------- 结果 ----------
if (mode === 'check') {
  log('\n检查完毕。');
} else if (mode === 'install') {
  ok(existsSync(join(seriesDir, 'xhsz-tools.ts')), '复制未生效');
  log('\n下一步：npm run build');
  log('构建产物：dist/zwu-ehallapp-assistant.user.js');
  log('装进浏览器后，先去一次 https://nxg.zwu.edu.cn/zhxg/#/certificateLogin 让 token 同步过来。');
} else {
  log('\n已回滚。注意 dist/ 里的旧产物还在，重新 build 一次才干净。');
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
