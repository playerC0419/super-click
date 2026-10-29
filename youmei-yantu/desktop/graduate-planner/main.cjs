'use strict';
const {app,BrowserWindow,protocol,session,Menu,dialog,shell}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
app.setName('优酶研途');
const profile=process.env.YANTU_TEST_USER_DATA||path.join(app.getPath('appData'),'YantuPlanner');
app.setPath('userData',profile);
protocol.registerSchemesAsPrivileged([{scheme:'yantu',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
let win,lastSnapshot='',closing=false,timer;
const root=path.join(__dirname,'app');
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8'};
const isLocal=url=>{try{const u=new URL(url);return u.protocol==='yantu:'&&u.hostname==='planner';}catch{return false;}};
async function external(url){try{const u=new URL(url);if(['https:','http:'].includes(u.protocol))await shell.openExternal(u.href);}catch{}}
async function snapshot(){
 if(!win||win.isDestroyed()||!isLocal(win.webContents.getURL()))return;
 const raw=await win.webContents.executeJavaScript("localStorage.getItem('yantu-planner-v1')");
 if(!raw)return;const data=JSON.parse(raw);if(!Array.isArray(data.nodes))return;
 const hash=crypto.createHash('sha256').update(raw).digest('hex');if(hash===lastSnapshot)return;
 const folder=path.join(profile,'Backups');await fs.mkdir(folder,{recursive:true});
 const name='plan-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
 await fs.writeFile(path.join(folder,name),raw,'utf8');lastSnapshot=hash;
 const files=(await fs.readdir(folder)).filter(n=>/^plan-.*\.json$/.test(n)).sort().reverse();
 for(const old of files.slice(10))await fs.unlink(path.join(folder,old));
}
if(!app.requestSingleInstanceLock())app.quit();
else{
 app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
 app.whenReady().then(async()=>{
  protocol.handle('yantu',async request=>{
   try{
    const u=new URL(request.url);if(u.hostname!=='planner')return new Response('Not found',{status:404});
    const rel=decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname);
    const file=path.resolve(root,'.'+rel);if(!file.startsWith(root+path.sep))return new Response('Forbidden',{status:403});
    return new Response(await fs.readFile(file),{headers:{'Content-Type':types[path.extname(file)]||'application/octet-stream','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'self'; frame-src 'none'",'X-Content-Type-Options':'nosniff'}});
   }catch{return new Response('Not found',{status:404});}
  });
  session.defaultSession.setPermissionRequestHandler((wc,permission,callback)=>callback(isLocal(wc.getURL())&&permission==='clipboard-sanitized-write'));
  session.defaultSession.on('will-download',(_event,item)=>item.setSaveDialogOptions({title:'保存优酶研途导出文件',defaultPath:path.join(app.getPath('downloads'),path.basename(item.getFilename()))}));
  win=new BrowserWindow({width:1440,height:960,minWidth:900,minHeight:640,show:false,title:'优酶研途',icon:path.join(__dirname,'icon.ico'),backgroundColor:'#101d2b',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:!app.isPackaged}});
  win.webContents.setWindowOpenHandler(({url})=>{external(url);return {action:'deny'};});
  win.webContents.on('will-navigate',(event,url)=>{if(!isLocal(url)){event.preventDefault();external(url);}});
  win.webContents.on('will-redirect',(event,url)=>{if(!isLocal(url))event.preventDefault();});
  Menu.setApplicationMenu(Menu.buildFromTemplate([
   {label:'文件',submenu:[{label:'备份与迁移',click:()=>win.webContents.executeJavaScript("document.querySelector('[data-action=backup]').click()")},{label:'打开本机数据目录',click:()=>shell.openPath(profile)},{label:'打开自动备份目录',click:async()=>{const dir=path.join(profile,'Backups');await fs.mkdir(dir,{recursive:true});await shell.openPath(dir);}},{label:'打印 / 导出 PDF',accelerator:'CmdOrCtrl+P',click:()=>win.webContents.print({printBackground:true})},{type:'separator'},{role:'quit',label:'退出'}]},
   {label:'编辑',submenu:[{role:'undo',label:'撤销'},{role:'redo',label:'重做'},{type:'separator'},{role:'cut',label:'剪切'},{role:'copy',label:'复制'},{role:'paste',label:'粘贴'},{role:'selectAll',label:'全选'}]},
   {label:'视图',submenu:[{role:'reload',label:'刷新'},{role:'resetZoom',label:'实际大小'},{role:'zoomIn',label:'放大'},{role:'zoomOut',label:'缩小'},{role:'togglefullscreen',label:'全屏'}]},
   {label:'帮助',submenu:[{label:'关于与使用说明',click:()=>dialog.showMessageBox(win,{type:'info',title:'关于优酶研途',message:'优酶研途 · 三年制硕士规划 v'+app.getVersion(),detail:'内置培养、就业、竞赛、项目、考证与材料规划。核心功能离线运行，外部通知链接需联网。\n\n个人数据保存在本机；每分钟及正常退出时，在内容变化后保存自动备份，保留最近 10 份。建议定期导出 JSON，换电脑时导入。\n\n从网页迁移：先在网页导出 JSON，再到桌面版「备份与迁移」导入。\n\n本程序不自动更新日程，具体安排请核对当年学院及主办方通知。'})}]}
  ]));
  win.once('ready-to-show',()=>{if(!process.env.YANTU_TEST_HEADLESS)win.show();});
  win.on('close',event=>{if(closing)return;event.preventDefault();closing=true;clearInterval(timer);snapshot().catch(e=>dialog.showErrorBox('自动备份未完成','已有本机数据仍保留，请定期手动导出 JSON。\n'+e.message)).finally(()=>{win.destroy();});});
  await win.loadURL('yantu://planner/index.html');
  timer=setInterval(()=>snapshot().catch(()=>{}),60000);
 });
 app.on('window-all-closed',()=>app.quit());
}
