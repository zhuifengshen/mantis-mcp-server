import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Operations } from '../../src/workflow/operations.js';
import { Tokens } from '../../src/workflow/tokens.js';
import { ScopedMetadataCache } from '../../src/cache.js';
let dirs: string[]=[];
afterEach(async()=>{await Promise.all(dirs.map(d=>rm(d,{recursive:true,force:true})));dirs=[];});
async function dir(){const d=await mkdtemp(join(tmpdir(),'mantis-ops-'));dirs.push(d);return d;}
describe('跨进程锁与主体隔离',()=>{
 it('存活进程的锁不可抢占，确认退出后回收',async()=>{
  const root=await dir();
  const source=`import {Operations} from './src/workflow/operations.ts';const o=new Operations(process.argv[1]);await o.lock('issue-1');process.stdout.write('ready');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source,root],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
  try{
   await once(child.stdout,'data');const ops=new Operations(root);
   expect(await ops.lock('issue-1')).toBeNull();
   const exited=once(child,'exit');child.kill('SIGTERM');await exited;
   const release=await ops.lock('issue-1');expect(release).not.toBeNull();await release!();
  }finally{child.kill('SIGKILL');}
 },10000);
 it('标识绑定用户、凭据密钥和对象，篡改或过期不能写',()=>{
  const key=randomBytes(32),a=new Tokens(key,7),b=new Tokens(key,8),c=new Tokens(randomBytes(32),7);
  const token=a.revision('issue:1','binding',{id:1}).expected_revision;
  expect(()=>b.check(token,'issue:1','binding',{id:1})).toThrow();expect(()=>c.open(token)).toThrow();
  expect(()=>a.check(token,'issue:2','binding',{id:1})).toThrow();expect(()=>a.open(token.slice(0,-4)+'AAAA')).toThrow();
 });
 it('元数据按主体和项目隔离，版本同步不延长 TTL',async()=>{
  const root=await dir();const a=new ScopedMetadataCache(join(root,'principal-a'),1),b=new ScopedMetadataCache(join(root,'principal-b'),1);
  await a.save(44,{versions:{items:[{id:1,name:'私有版本'}]},categories:{items:[]}});
  expect(await b.load(44)).toBeNull();expect(await a.load(45)).toBeNull();
  const path=join(root,'principal-a','metadata','44.json');const old=JSON.parse(await readFile(path,'utf8'));
  await a.patchVersions(44,[{id:1,name:'改名'}]);const current=JSON.parse(await readFile(path,'utf8'));
  expect(current.timestamp).toBe(old.timestamp);expect(current.sections.versions.items[0].name).toBe('改名');
  old.timestamp=Date.now()-2000;await writeFile(path,JSON.stringify(old));expect(await a.load(44)).toBeNull();
 });
});
