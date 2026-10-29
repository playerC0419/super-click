#!/usr/bin/env node
/** Local staged upgrade: validate first, save verified rollback, replace code only. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url)),source=path.resolve(process.argv[2]??root),apply=process.argv.includes('--apply');
const names=['src','dist','scripts','bin','skills','test','docs','README.md','.env.example','package.json','package-lock.json','tsconfig.json'];
const required=['dist/platform/http.js','scripts/windows-supervisor.mjs','scripts/windows-control.mjs','test/platform.test.ts','test/desktop-queue.test.ts','test/ui-rework.test.ts'];
function run(args,cwd){const p=spawnSync(process.execPath,args,{cwd,stdio:'inherit',windowsHide:true});if(p.status!==0)throw Error('升级预检或服务操作未通过，退出码 '+p.status);}
function noLinks(dir){for(const n of fs.readdirSync(dir)){if(n==='node_modules'||n==='.git')continue;const f=path.join(dir,n),s=fs.lstatSync(f);if(s.isSymbolicLink())throw Error('升级代码含链接：'+f);if(s.isDirectory())noLinks(f);}}
try{
 for(const name of required)if(!fs.existsSync(path.join(source,name)))throw Error('升级包缺少 Windows 工作流组件：'+name);
 for(const name of names){const f=path.join(source,name);if(!fs.existsSync(f))throw Error('升级包不完整：'+name);if(fs.lstatSync(f).isSymbolicLink())throw Error('升级源不能是链接');if(fs.statSync(f).isDirectory())noLinks(f);}
 run([path.join(source,'node_modules/typescript/bin/tsc'),'-p','tsconfig.json'],source);
 run([path.join(source,'node_modules/tsx/dist/cli.mjs'),'--test','test/platform.test.ts','test/desktop-queue.test.ts','test/ui-rework.test.ts'],source);
 const candidate=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8')),installed=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));const normalized=v=>JSON.stringify(Object.entries(v??{}).sort(([a],[b])=>a.localeCompare(b)));for(const key of ['dependencies','devDependencies'])if(normalized(candidate[key])!==normalized(installed[key]))throw Error('升级包依赖有变化，需要先准备兼容运行环境；本次未替换安装');const version=candidate.version;
 if(!apply){console.log(JSON.stringify({verified:true,version,source,applied:false,instructions:'使用 --apply 执行，执行前自动备份；配置、凭据、业务目录保留。'}));process.exit(0);}
 if(fs.realpathSync(source)===fs.realpathSync(root))throw Error('不能以当前安装目录作为升级替换源');
 const token=fs.readFileSync(path.join(root,'data/platform/api-token'),'utf8').trim();const response=await fetch('http://127.0.0.1:18492/v1/backups',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(600000)});const backup=await response.json();if(!response.ok)throw Error(JSON.stringify(backup));
 const record={createdAt:new Date().toISOString(),source,version,backupId:backup.id,state:'prepared'};fs.writeFileSync(path.join(root,'data/last-upgrade.json'),JSON.stringify(record));
 run([path.join(root,'scripts/windows-control.mjs'),'stop'],root);
 try{for(const name of names)fs.cpSync(path.join(source,name),path.join(root,name),{recursive:true,force:true});record.state='installed';fs.writeFileSync(path.join(root,'data/last-upgrade.json'),JSON.stringify(record));run([path.join(root,'scripts/windows-control.mjs'),'start'],root);}catch(error){run([path.join(root,'scripts/windows-control.mjs'),'restore',backup.id],root);throw error;}
 console.log(JSON.stringify({upgraded:true,version,rollbackBackupId:backup.id}));
}catch(error){console.error(error.message);process.exitCode=1;}
