import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import type { IncomingMessage } from 'node:http';
import { HubError, type Artifact, type HubRun, type TaskAttachment } from './contracts.js';
import { writePrivateJson } from '../run-journal.js';

export function contained(root:string,file:string){const rel=path.relative(root,file);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}
export function safeName(name:string){const value=path.basename(name.replaceAll('\\','/')).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,160);if(!value||value==='.'||value==='..'||/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(value))throw new HubError('INVALID_FILENAME','文件名称不可用');return value;}
export function digest(file:string){const hash=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.alloc(1024*1024);try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,n));return hash.digest('hex');}finally{fs.closeSync(fd);}}
export async function receiveUpload(directory:string,req:IncomingMessage):Promise<TaskAttachment>{
  const name=safeName(decodeURIComponent(String(req.headers['x-file-name']??''))),id=crypto.randomUUID();
  const root=path.join(directory,'uploads',id);fs.mkdirSync(root,{recursive:true,mode:0o700});
  const file=path.join(root,name),fd=fs.openSync(file,'wx',0o600),hash=crypto.createHash('sha256');let bytes=0,complete=false;
  const configured=Number(process.env.AGENT_HUB_UPLOAD_MAX_MB??256);const maximum=Math.min(1024*1024*1024,(Number.isFinite(configured)&&configured>0?configured:256)*1024*1024);
  try{for await(const value of req){const chunk=Buffer.from(value);bytes+=chunk.length;if(bytes>maximum)throw new HubError('UPLOAD_TOO_LARGE',`附件超过 ${Math.round(maximum/1024/1024)} MB 限制`,413);fs.writeSync(fd,chunk);hash.update(chunk);}if(!bytes)throw new HubError('EMPTY_UPLOAD','附件不能为空');complete=true;}
  finally{fs.closeSync(fd);if(!complete){fs.rmSync(file,{force:true});fs.rmdirSync(root);}}
  const attachment={id,name,path:file,bytes,sha256:hash.digest('hex')};writePrivateJson(path.join(root,'manifest.json'),attachment);return attachment;
}
export function loadAttachments(directory:string,ids:string[]):TaskAttachment[]{return [...new Set(ids)].map(id=>{
  if(!/^[a-f0-9-]{36}$/.test(id))throw new HubError('INVALID_UPLOAD','附件编号无效');
  const root=path.join(directory,'uploads',id);let data:TaskAttachment;try{data=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));}catch{throw new HubError('UPLOAD_NOT_FOUND','附件不存在，请重新上传',404);}
  const actual=fs.realpathSync(data.path);if(!contained(fs.realpathSync(root),actual)||!fs.statSync(actual).isFile()||digest(actual)!==data.sha256)throw new HubError('UPLOAD_CHANGED','附件已变化，请重新上传',409);return {...data,path:actual};
});}
export function attachToWorkspace(run:HubRun,items:TaskAttachment[]):TaskAttachment[]{return items.map(item=>{
  const root=path.join(run.workspace,'.agent-hub-materials',item.id);fs.mkdirSync(root,{recursive:true,mode:0o700});
  if(!contained(fs.realpathSync(run.workspace),fs.realpathSync(root)))throw new HubError('INVALID_UPLOAD','材料目录不在本任务中');
  const target=path.join(root,safeName(item.name));if(fs.existsSync(target)){if(fs.lstatSync(target).isSymbolicLink()||digest(target)!==item.sha256)throw new HubError('UPLOAD_CHANGED','已存在的附件与上传内容不一致',409);}else fs.copyFileSync(item.path,target,fs.constants.COPYFILE_EXCL);
  return {...item,path:target};
});}
export function snapshotArtifacts(run:HubRun,artifacts:Artifact[]):Artifact[]{return artifacts.map((artifact,index)=>{
  const folder=path.join(path.dirname(run.resultFile),'artifacts');fs.mkdirSync(folder,{recursive:true,mode:0o700});
  if(!contained(fs.realpathSync(path.dirname(run.resultFile)),fs.realpathSync(folder)))throw new HubError('INVALID_ARTIFACT','版本目录已被替换');
  const target=path.join(folder,`${index}-${safeName(artifact.name)}`);
  if(!fs.existsSync(target))fs.copyFileSync(artifact.path,target,fs.constants.COPYFILE_EXCL);
  if(fs.lstatSync(target).isSymbolicLink())throw new HubError('INVALID_ARTIFACT','版本文件不可为链接');
  return {...artifact,snapshotPath:target,sha256:digest(target),capturedAt:new Date().toISOString()};
});}
export function versionArtifact(run:HubRun,round:number,index:number):Artifact{
  const result=round===run.round?run.result:run.history?.find(r=>r.round===round)?.result;
  const artifact=result?.artifacts[index];if(!artifact)throw new HubError('NOT_FOUND','该轮成果不存在',404);
  const file=artifact.snapshotPath??artifact.path;const actual=fs.realpathSync(file);
  const roots=artifact.snapshotPath?[path.join(path.dirname(path.dirname(run.resultFile)),`round-${round}`)]:[run.workspace,path.dirname(run.resultFile)];
  if(!roots.some(root=>contained(root,actual))||!fs.statSync(actual).isFile())throw new HubError('INVALID_ARTIFACT','成果文件已被替换',409);
  if(artifact.sha256&&digest(actual)!==artifact.sha256)throw new HubError('ARTIFACT_CHANGED','保留版本的校验值不符',409);
  return {...artifact,path:actual};
}
export function contentType(name:string){return ({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.pdf':'application/pdf','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8','.csv':'text/plain; charset=utf-8','.json':'text/plain; charset=utf-8','.html':'text/plain; charset=utf-8','.svg':'text/plain; charset=utf-8','.js':'text/plain; charset=utf-8','.py':'text/plain; charset=utf-8'})[path.extname(name).toLowerCase()]??'application/octet-stream';}
function zipEntries(file:string):Map<string,Buffer>{
  const stat=fs.statSync(file);if(stat.size>128*1024*1024)throw new HubError('PREVIEW_TOO_LARGE','文件过大，请下载查看',413);
  const data=fs.readFileSync(file),out=new Map<string,Buffer>();let end=-1;
  for(let i=data.length-22;i>=Math.max(0,data.length-65557);i--)if(data.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0)throw new HubError('INVALID_DOCUMENT','不是可预览的 Office 文件');
  let pos=data.readUInt32LE(end+16),expanded=0;
  for(let i=0;i<data.readUInt16LE(end+10);i++){
    if(pos+46>data.length||data.readUInt32LE(pos)!==0x02014b50)throw new HubError('INVALID_DOCUMENT','文件目录损坏');
    const method=data.readUInt16LE(pos+10),size=data.readUInt32LE(pos+20),plain=data.readUInt32LE(pos+24),len=data.readUInt16LE(pos+28),extra=data.readUInt16LE(pos+30),comment=data.readUInt16LE(pos+32),offset=data.readUInt32LE(pos+42),name=data.subarray(pos+46,pos+46+len).toString('utf8');pos+=46+len+extra+comment;
    if(!/^ppt\/slides\/slide\d+\.xml$/.test(name)&&!/^word\/document\.xml$/.test(name))continue;
    expanded+=plain;if(plain>4*1024*1024||expanded>16*1024*1024||offset+30>data.length||data.readUInt32LE(offset)!==0x04034b50)throw new HubError('PREVIEW_TOO_LARGE','文档内容超过预览限制',413);
    const start=offset+30+data.readUInt16LE(offset+26)+data.readUInt16LE(offset+28);if(start+size>data.length)throw new HubError('INVALID_DOCUMENT','文档数据不完整');
    const packed=data.subarray(start,start+size);if(method===0)out.set(name,packed);else if(method===8)out.set(name,inflateRawSync(packed,{maxOutputLength:4*1024*1024}));
  }return out;
}
export function documentOverview(file:string){const files=zipEntries(file);return [...files].sort((a,b)=>Number(a[0].match(/slide(\d+)/)?.[1]??0)-Number(b[0].match(/slide(\d+)/)?.[1]??0)).map(([name,data])=>({name,text:[...data.toString('utf8').matchAll(/<(?:a|w):t(?:\s[^>]*)?>([\s\S]*?)<\/(?:a|w):t>/g)].map(m=>m[1]!.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&')).join('\n')}));}
