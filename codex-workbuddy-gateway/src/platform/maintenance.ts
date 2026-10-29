import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import type { HubEngine } from './engine.js';
import { HubError } from './contracts.js';
import { contained, digest } from './files.js';
import { writePrivateJson } from '../run-journal.js';

const codeNames=['src','dist','scripts','bin','skills','test','docs','README.md','.env.example','package.json','package-lock.json','tsconfig.json'];
export function redact(text:string){return text.replace(/(Bearer\s+)[^\s"']+/gi,'$1[redacted]').replace(/((?:leaseToken|lease-token|token|password|secret|api[_-]?key)["'\s:=]+)[^\s,"'}]+/gi,'$1[redacted]').replace(/([?&]accountSnapshot=)[^\s"']+/gi,'$1[redacted]').replace(/\b[a-f0-9]{48,}\b/gi,'[redacted]');}
export function diagnostic(engine:HubEngine,root:string){
  const logdir=path.join(root,'data','service-logs');const logs=fs.existsSync(logdir)?fs.readdirSync(logdir).filter(n=>n.endsWith('.log')).slice(0,8).map(name=>{
    const file=path.join(logdir,name),fd=fs.openSync(file,'r');try{const stat=fs.fstatSync(fd),size=Math.min(stat.size,48000),data=Buffer.alloc(size);fs.readSync(fd,data,0,size,stat.size-size);return {name,bytes:stat.size,tail:redact(data.toString('utf8')).split('\n').slice(-100).join('\n')};}finally{fs.closeSync(fd);}
  }):[];
  return {createdAt:new Date().toISOString(),version:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,platform:process.platform,node:process.version,queue:engine.queueState(),counts:engine.store.all().reduce((counts:Record<string,number>,run)=>({...counts,[run.status]:(counts[run.status]??0)+1}),{}),logs};
}
export function assertIdle(engine:HubEngine){if(engine.store.all().some(r=>r.holdsCapacity||['dispatching','submitted','running','cancel_requested','uncertain'].includes(r.status)))throw new HubError('RUN_ACTIVE','有任务尚未确认结束，请先完成或停止后再维护',409);}
export function backupList(directory:string){const root=path.join(directory,'backups');if(!fs.existsSync(root))return [];return fs.readdirSync(root).filter(n=>/^backup-[a-f0-9-]{36}$/.test(n)).flatMap(id=>{try{const m=JSON.parse(fs.readFileSync(path.join(root,id,'manifest.json'),'utf8'));return [{id,createdAt:m.createdAt,files:m.files.length,bytes:m.files.reduce((n:number,f:{bytes:number})=>n+f.bytes,0),version:m.version}];}catch{return [];}}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
export async function makeBackup(engine:HubEngine,root:string){return engine.exclusive(async()=>{
  assertIdle(engine);engine.maintenanceActive=true;
  const id='backup-'+crypto.randomUUID(),folder=path.join(engine.directory,'backups',id);fs.mkdirSync(folder,{recursive:true,mode:0o700});
  fs.mkdirSync(path.join(folder,'data'),{recursive:true});
  try{
    for(const name of codeNames){const source=path.join(root,name);if(fs.existsSync(source))await fs.promises.cp(source,path.join(folder,name),{recursive:true,filter:src=>!fs.lstatSync(src).isSymbolicLink()});}
    const dataNames=['persistent-service.json','runs','tasks.sqlite'];
    const sourceData=path.join(root,'data');
    for(const name of dataNames){const source=path.join(sourceData,name);if(!fs.existsSync(source))continue;
      if(name==='runs'){
        await fs.promises.cp(source,path.join(folder,'data',name),{recursive:true,filter:src=>!fs.lstatSync(src).isSymbolicLink()&&!/\.sqlite(?:-shm|-wal)?$|\.lock$|\.tmp$/.test(src)&&!src.includes('desktop-listeners')&&!src.includes('queue-session-locks')});
        for(const db of ['workspace-workers.sqlite','persistent-service.sqlite'])if(fs.existsSync(path.join(source,db))){const from=new DatabaseSync(path.join(source,db),{readOnly:true});try{await backup(from,path.join(folder,'data/runs',db));}finally{from.close();}}
      }else if(name.endsWith('.sqlite')){const from=new DatabaseSync(source,{readOnly:true});try{await backup(from,path.join(folder,'data',name));}finally{from.close();}}
      else await fs.promises.copyFile(source,path.join(folder,'data',name));
    }
    fs.mkdirSync(path.join(folder,'data/platform'),{recursive:true});await engine.store.backup(path.join(folder,'data/platform/hub.sqlite'));
    for(const name of ['results','uploads','workspaces']){const source=path.join(engine.directory,name);if(fs.existsSync(source))await fs.promises.cp(source,path.join(folder,'data/platform',name),{recursive:true,filter:src=>!fs.lstatSync(src).isSymbolicLink()&&!src.split(path.sep).some(n=>['node_modules','.git','.venv','__pycache__'].includes(n))});}
    const env=path.join(root,'.env');if(fs.existsSync(env))fs.writeFileSync(path.join(folder,'.env'),fs.readFileSync(env,'utf8').split(/\r?\n/).map(line=>/^\s*[\w]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=/.test(line)?line.slice(0,line.indexOf('=')+1):line).join('\n'),{mode:0o600});
    const files:Array<{name:string;bytes:number;sha256:string}>=[];const walk=(dir:string)=>{for(const name of fs.readdirSync(dir)){const file=path.join(dir,name);if(fs.statSync(file).isDirectory())walk(file);else files.push({name:path.relative(folder,file).replaceAll('\\','/'),bytes:fs.statSync(file).size,sha256:digest(file)});}};walk(folder);
    const manifest={id,createdAt:new Date().toISOString(),sourceRoot:root,version:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,files,credentialsIncluded:false,nativeWorkBuddyDataIncluded:false};writePrivateJson(path.join(folder,'manifest.json'),manifest);return {id,createdAt:manifest.createdAt,files:files.length,folder};
  }finally{engine.maintenanceActive=false;}
});}
export function verifyBackup(directory:string,id:string){if(!/^backup-[a-f0-9-]{36}$/.test(id))throw new HubError('INVALID_BACKUP','备份编号无效');const folder=path.join(directory,'backups',id),manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8'));for(const entry of manifest.files){const file=path.resolve(folder,entry.name);if(!contained(folder,file)||!contained(folder,fs.realpathSync(file))||digest(file)!==entry.sha256)throw new HubError('BACKUP_CHANGED','备份文件不完整或已变化',409);}return {folder,manifest};}
export async function restoreBackup(directory:string,id:string,targetRoot:string){
  const {folder,manifest}=verifyBackup(directory,id);
  // Intended for the stopped-service CLI. Restored queued work remains paused.
  fs.mkdirSync(targetRoot,{recursive:true});
  for(const name of ['data/platform/hub.sqlite','data/tasks.sqlite','data/runs/workspace-workers.sqlite','data/runs/persistent-service.sqlite'])for(const suffix of ['-wal','-shm']){const file=path.resolve(targetRoot,name+suffix);if(!contained(path.resolve(targetRoot),file))throw new Error('Invalid restore database path');fs.rmSync(file,{force:true});}
  for(const entry of manifest.files){const target=path.resolve(targetRoot,entry.name);if(!contained(targetRoot,target))throw new Error('Restore target escapes installation');fs.mkdirSync(path.dirname(target),{recursive:true});if(!contained(fs.realpathSync(targetRoot),fs.realpathSync(path.dirname(target))))throw new Error('Restore directory is a link outside installation');if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw new Error('Restore target is a link');await fs.promises.copyFile(path.join(folder,entry.name),target);}
  const dbfile=path.join(targetRoot,'data/platform/hub.sqlite');if(fs.existsSync(dbfile)){const db=new DatabaseSync(dbfile);try{db.exec('CREATE TABLE IF NOT EXISTS hub_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');db.prepare('INSERT INTO hub_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('queue',JSON.stringify({paused:true}));}finally{db.close();}}
  return {ok:true,id,targetRoot,queuePaused:true,requiresRebind:path.resolve(manifest.sourceRoot)!==path.resolve(targetRoot)};
}
