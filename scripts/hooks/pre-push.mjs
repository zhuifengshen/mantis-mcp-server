#!/usr/bin/env node
// 推送前只执行类型检查，不改写提交或触发其他远程推送。
import { spawnSync } from 'node:child_process';

const [command, args] = process.platform === 'win32'
  ? ['cmd.exe', ['/c', 'npm', 'run', 'typecheck']]
  : ['npm', ['run', 'typecheck']];
const result = spawnSync(command, args, { stdio: 'inherit' });
if (result.error || result.status !== 0) {
  console.error('类型检查失败，已停止推送。');
  process.exit(1);
}
