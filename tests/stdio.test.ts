import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { defaultTools, adminTools, writeOutput } from '../src/workflow/contracts.js';
import { configValues } from './helpers/workflow.js';
const preload = `
 const values = ${JSON.stringify(configValues)};
 let issue = {id:1,summary:'合成缺陷',description:'原文',project:{id:44,name:'Demo'},status:{id:50},resolution:{id:10},handler:{id:7,name:'tester'},notes:[],attachments:[],updated_at:'2026-10-01T00:00:00Z'};
 globalThis.fetch = async (input, init) => {
  const u = new URL(String(input)); const p=u.pathname.replace('/api/rest/','');
  if (u.origin !== 'https://mantis.invalid') throw new Error('意外网络请求');
  process.stderr.write('REST '+init.method+' '+p+'\\n');
  const response = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'X-Mantis-Version':'2.26.2'}});
  if(p==='users/me')return response({id:7,name:'tester'});
  if(p==='projects')return response({projects:[{id:44,name:'Demo'}]});
  if(p==='projects/44')return response({projects:[{id:44,name:'Demo',categories:[{id:1,name:'测试'}]}]});
  if(p==='config')return response({configs:Object.entries(values).map(([option,value])=>({option,value}))});
  if(p==='issues/1'&&init.method==='GET')return response({issues:[issue]});
  if(p==='issues/1'&&init.method==='PATCH'){Object.assign(issue,JSON.parse(init.body));return response({issues:[issue]});}
  if(p==='issues/1/notes'&&init.method==='POST'){const note={id:1,...JSON.parse(init.body),reporter:{id:7,name:'tester'}};issue.notes.push(note);return response({note},201);}
  return response({},403);
 };
`;
async function connect(admin: boolean) {
 const dir=await mkdtemp(join(tmpdir(),'mantis-stdio-'));
 const client=new Client({name:'workflow-contract',version:'1.0.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:['--import','data:text/javascript,'+encodeURIComponent(preload),'--import','tsx','src/index.ts'],cwd:process.cwd(),
  env:{MANTIS_BASE_URL:'https://mantis.invalid',MANTIS_API_KEY:'synthetic-key',MANTIS_CACHE_DIR:dir,MANTIS_WORKFLOW_CONFIG:join(process.cwd(),'docs/workflow-config.example.json'),MANTIS_MCP_ENABLE_DESTRUCTIVE_TOOLS:String(admin),TRANSPORT:'http',MANTIS_SEARCH_ENABLED:'true'},stderr:'pipe'});
 let logs='';transport.stderr?.on('data',chunk=>{logs+=String(chunk);});
 await client.connect(transport);
 return {client,logs:()=>logs,cleanup:async()=>{await client.close();await rm(dir,{recursive:true,force:true});}};
}
describe('真实 stdio 协议契约',()=>{
 it.each([false,true])('唯一扩展开关 %s 固定注册 13/23 工具，旧调用无旁路',async admin=>{
  const h=await connect(admin);
  try{
   expect(h.logs()).not.toContain('REST ');
   const {tools}=await h.client.listTools();
   expect(tools.map(t=>t.name).sort()).toEqual([...defaultTools,...(admin?adminTools:[])].sort());
   for(const tool of tools){expect(tool.outputSchema?.type).toBe('object');expect(tool.inputSchema.additionalProperties).toBe(false);expect(tool.description).toMatch(/[\u4e00-\u9fff]/);expect(tool.annotations?.openWorldHint).toBe(true);}
   for(const name of ['update_issue','create_issue','get_issue',...(!admin?['close_issue']:[])]){
    expect((await h.client.callTool({name,arguments:{}})).isError).toBe(true);
   }
   expect((await h.client.listPrompts()).prompts).toHaveLength(5);
   expect((await h.client.listResources()).resources.map(r=>r.uri).sort()).toEqual(['mantis://enums','mantis://me','mantis://projects','mantis://projects/44']);
   expect((await h.client.listResourceTemplates()).resourceTemplates).toHaveLength(1);
  }finally{await h.cleanup();}
 },15000);
 it('严格输入零写入，结构化结果与 JSON 文本一致，成功回读可直接使用',async()=>{
  const h=await connect(false);
  try{
   const invalid=await h.client.callTool({name:'submit_fix',arguments:{issue_id:1,status:80,self_test:{result:'failed',summary:'失败'}}});
   expect(invalid.isError).toBe(true);expect(h.logs()).not.toContain('REST ');
   const context=await h.client.callTool({name:'get_issue_context',arguments:{issue_id:1}});
   const input={issue_id:1,expected_revision:(context.structuredContent as Record<string,unknown>)?.expected_revision,operation_id:randomUUID(),fix_summary:'修复合成断言',self_test:{result:'passed',summary:'合成回归已通过'}};
   const result=await h.client.callTool({name:'submit_fix',arguments:input});
   expect(result.isError).toBe(false);expect((result.structuredContent as Record<string,unknown>)?.outcome).toBe('succeeded');
   expect(writeOutput.safeParse(result.structuredContent).success).toBe(true);
   expect(JSON.parse((result.content as Array<{text:string}>)[0].text)).toEqual(result.structuredContent);
   await h.client.callTool({name:'submit_fix',arguments:input});
   expect(h.logs().match(/REST PATCH /g)).toHaveLength(1);expect(h.logs().match(/REST POST /g)).toHaveLength(1);
  }finally{await h.cleanup();}
 },15000);
});
