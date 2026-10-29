/* Shared mobile browser/PWA UI. Native integration is attached by native-entry.js. */
(()=>{'use strict';
let promptEvent,registration;const key='yantu-planner-v1';
const notice=text=>{const el=document.querySelector('#toast');el.textContent=text;el.classList.add('visible');setTimeout(()=>el.classList.remove('visible'),4500);};
const baseURL=()=>new URL('./',location.href).href;
function instructions(){
 const native=!!window.YantuNative,root=document.querySelector('#overlay-root');
 root.innerHTML=`<div class="overlay"><div class="modal install-guide" role="dialog" aria-modal="true" aria-labelledby="mobile-install-title"><h2 id="mobile-install-title">${native?'研途 · 安卓离线版':'安装到手机主屏幕'}</h2>${native?'<p>全部规划与指南已包含在安装包内。编辑保存在本机，卸载会删除应用数据，请先导出 JSON 备份。</p><p>点击「备份 / 导入」可导出并通过手机分享菜单保存到文件、网盘或发送给自己。外部通知链接需要联网。</p>':'<p>免费使用，无需应用商店账号。首次打开并完成离线准备后，可从主屏幕图标离线启动。</p><ol><li><strong>安卓：</strong>用 Chrome / Edge 打开，点菜单中的「安装应用」或「添加到主屏幕」。若浏览器提供安装提示，也可点下方安装按钮。</li><li><strong>iPhone：</strong>用 Safari 打开，点分享按钮 →「添加到主屏幕」→「添加」。若有「作为网页 App 打开」选项，请开启。</li><li>添加后从主屏幕图标打开，确认显示「离线可用」，再开飞行模式测试。</li></ol>'}<div class="backup-note">手机、浏览器与电脑之间不会自动同步。安装前先导出原规划，再从主屏幕版本导入；清除网站数据、卸载或换域名可能导致本机记录丢失。请定期将 JSON 另存到「文件」或网盘。</div><div class="modal-actions">${!native&&promptEvent?'<button class="button primary" id="confirm-install">安装应用</button>':''}<button class="button" data-action="close">关闭</button></div></div></div>`;
 root.querySelector('#confirm-install')?.addEventListener('click',async()=>{const event=promptEvent;promptEvent=null;await event.prompt();await event.userChoice;root.querySelector('#confirm-install')?.remove();});
}
function addTools(){if(document.querySelector('.phone-tools'))return;const bar=document.createElement('div');bar.className='phone-tools';bar.innerHTML='<button class="button" data-mobile-action="install">手机安装 / 使用</button><span class="offline-state" role="status">正在准备离线资源…</span>';document.querySelector('main').before(bar);bar.style.margin='14px 14px 0';updateStatus();}
function updateStatus(message){const el=document.querySelector('.offline-state');if(!el)return;if(message)el.textContent=message;else if(window.YantuNative)el.textContent='安卓离线版 · 本机保存';else el.textContent=navigator.serviceWorker?.controller?'离线可用 · 请定期备份':navigator.onLine?'首次使用：正在准备离线资源':'尚未完成离线准备';}
async function download(text,name,type){
 try{
  if(window.YantuNative){await window.YantuNative.exportFile(text,name,type);notice('已打开系统分享，请选择保存位置');return;}
  const file=new File([text],name,{type:type.split(';')[0]});
  if(navigator.share&&navigator.canShare?.({files:[file]})&&matchMedia('(pointer:coarse)').matches){await navigator.share({files:[file],title:name});notice('已完成文件分享，请确认已保存');return;}
  const url=URL.createObjectURL(file),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);notice('已发起导出，请在下载列表中确认文件');
 }catch(e){if(e.name!=='AbortError')notice('导出未完成：'+e.message);}
}
window.MobilePlanner={download,notice,instructions,persist:raw=>window.YantuNative?.persist(raw),baseURL};
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();promptEvent=e;});
window.addEventListener('appinstalled',()=>{promptEvent=null;updateStatus('已添加到主屏幕 · 请定期备份');});
document.addEventListener('click',e=>{const el=e.target.closest('[data-mobile-action]');if(el){e.preventDefault();e.stopImmediatePropagation();instructions();}},true);
document.addEventListener('click',e=>{const a=e.target.closest('a[href]');if(a&&window.YantuNative){let u;try{u=new URL(a.href);}catch{return;}if(['http:','https:'].includes(u.protocol)&&u.origin!==location.origin){e.preventDefault();e.stopImmediatePropagation();window.YantuNative.openExternal(u.href);}}},true);
window.addEventListener('online',()=>updateStatus());window.addEventListener('offline',()=>updateStatus());
window.addEventListener('yantu-native-ready',()=>updateStatus());
window.addEventListener('load',async()=>{
 addTools();
 if(window.YantuNative||window.YANTU_NATIVE_BOOTSTRAP){document.body.classList.add('native-build');updateStatus('手机离线版 · 本机保存');return;}
 if('serviceWorker'in navigator&&window.isSecureContext){try{registration=await navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'});await navigator.serviceWorker.ready;navigator.serviceWorker.addEventListener('controllerchange',()=>updateStatus());updateStatus();registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)updateStatus('新版已下载，下次完全关闭后打开即可更新');});});}catch{updateStatus('离线准备失败，请联网刷新重试');}}
 else updateStatus('此环境不支持离线安装，请使用 HTTPS 地址');
});
})();
