#!/usr/bin/env node
// 项目初始化：npm run init
//
// 执行步骤：
//   1. 检查 Node.js 版本（22.12+、24.x 或 26+，与工具链要求一致）
//   2. 安装依赖
//   3. 安装仅执行类型检查的 Git 钩子
//   4. 运行类型检查

import { spawnSync } from 'node:child_process';
import { copyFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Windows 通过 cmd.exe 调用 npm，避免启用 shell:true。
const [npmBin, npmBaseArgs] = process.platform === 'win32'
  ? ['cmd.exe', ['/c', 'npm']]
  : ['npm', []];

// ---------------------------------------------------------------------------
// 1. 检查 Node.js 版本
// ---------------------------------------------------------------------------

const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 12) || major === 24 || major >= 26)) {
  console.error(`✗ 需要 Node.js 22.12+、24.x 或 26+，当前版本为 ${process.version}`);
  process.exit(1);
}
console.log(`✓ Node.js ${process.version}`);

// ---------------------------------------------------------------------------
// 2. 安装依赖
// ---------------------------------------------------------------------------

console.log('\n→ 正在安装依赖……');
const install = spawnSync(npmBin, [...npmBaseArgs, 'install'], {
  stdio: 'inherit',
  cwd: root,
});
if (install.status !== 0) {
  console.error('✗ npm install 失败');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. 安装 Git 钩子
// ---------------------------------------------------------------------------

console.log('\n→ 正在安装 Git 钩子……');

const hooksSourceDir = resolve(root, 'scripts/hooks');
const gitHooksDir = resolve(root, '.git/hooks');

if (!existsSync(gitHooksDir)) {
  mkdirSync(gitHooksDir, { recursive: true });
}

const hooks = ['pre-push'];
for (const hook of hooks) {
  const src = resolve(hooksSourceDir, `${hook}.mjs`);
  const dest = resolve(gitHooksDir, hook);

  if (!existsSync(src)) {
    console.warn(`  ⚠ 未找到钩子源文件，跳过： scripts/hooks/${hook}.mjs`);
    continue;
  }

  copyFileSync(src, dest);

  // 设置执行权限；Windows 由 Git 处理脚本执行。
  try {
    chmodSync(dest, 0o755);
  } catch {
    // 不支持 chmod 的平台可忽略。
  }

  console.log(`  ✓ .git/hooks/${hook} 已安装`);
}

// ---------------------------------------------------------------------------
// 4. 类型检查
// ---------------------------------------------------------------------------

console.log('\n→ 正在执行类型检查……');
const check = spawnSync(npmBin, [...npmBaseArgs, 'run', 'typecheck'], {
  stdio: 'inherit',
  cwd: root,
});
if (check.status !== 0) {
  console.error('✗ 类型检查失败，请查看上述错误');
  process.exit(1);
}

console.log('\n✓ 初始化完成。');
