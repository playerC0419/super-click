import {Capacitor,registerPlugin} from '@capacitor/core';
import {Preferences} from '@capacitor/preferences';
import {Filesystem,Directory,Encoding} from '@capacitor/filesystem';
import {Share} from '@capacitor/share';
import {Browser} from '@capacitor/browser';
import {App} from '@capacitor/app';
window.YANTU_NATIVE_BOOTSTRAP=true;
const key='yantu-planner-v1';let pending=Promise.resolve(),lastBackup=0;
function persist(raw){
 pending=pending.catch(()=>{}).then(async()=>{
  await Preferences.set({key,value:raw});
  if(Date.now()-lastBackup>60000){await Filesystem.writeFile({path:'Backups/latest.json',data:raw,directory:Directory.Data,encoding:Encoding.UTF8,recursive:true});lastBackup=Date.now();}
 }).catch(e=>window.MobilePlanner?.notice('本机持久保存未完成，请立即导出备份：'+e.message));
 return pending;
}
async function bootstrap(){
 if(Capacitor.isNativePlatform()){
  const candidates=[];
  const accept=raw=>{try{const data=JSON.parse(raw);if(data?.schemaVersion===1&&Array.isArray(data.nodes)&&Array.isArray(data.annual))candidates.push({raw,at:Number(data.savedAt)||0});}catch{}};
  accept(localStorage.getItem(key));
  try{const {value}=await Preferences.get({key});accept(value);}catch{}
  if(!candidates.length){try{const backup=await Filesystem.readFile({path:'Backups/latest.json',directory:Directory.Data,encoding:Encoding.UTF8});accept(backup.data);}catch{}}
  if(candidates.length)localStorage.setItem(key,candidates.sort((a,b)=>b.at-a.at)[0].raw);
  window.YantuNative={persist,print:async()=>{try{if(Capacitor.getPlatform()==='android')await registerPlugin('YantuPrint').print();else window.MobilePlanner?.notice('iPhone 原生工程暂未接入打印，请先导出 CSV。');}catch(e){window.MobilePlanner?.notice('打印未完成：'+e.message);}},exportFile:async(text,name)=>{
   const safe=name.replace(/[/\\:*?"<>|]/g,'_');
   const {uri}=await Filesystem.writeFile({path:'exports/'+Date.now()+'-'+safe,data:text,directory:Directory.Cache,encoding:Encoding.UTF8,recursive:true});
   await Share.share({title:name,files:[uri],dialogTitle:'保存或分享优酶研途文件'});
  },openExternal:async url=>{if(/^https?:\/\//.test(url))await Browser.open({url});}};
  document.body.classList.add('native-build');window.dispatchEvent(new Event('yantu-native-ready'));
  if(Capacitor.getPlatform()==='android')await App.addListener('backButton',()=>{const overlay=document.querySelector('#overlay-root');if(overlay.children.length){overlay.querySelector('[data-action=close]')?.click();return;}const sidebar=document.querySelector('#sidebar');if(sidebar.classList.contains('open')){sidebar.classList.remove('open');return;}if(location.hash&&location.hash!=='#timeline'){location.hash='timeline';return;}App.minimizeApp();});
  await App.addListener('appStateChange',({isActive})=>{if(!isActive){const raw=localStorage.getItem(key);if(raw)persist(raw);}});
 }
 const script=document.createElement('script');script.src='./app.js';document.body.append(script);
}
bootstrap().catch(e=>{document.querySelector('#main').textContent='启动未完成，请关闭后重试。'+e.message;});
