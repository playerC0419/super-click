(()=>{'use strict';const splash=document.querySelector('#brand-startup');if(!splash)return;const started=performance.now();let ready=false;
const slow=setTimeout(()=>{if(!ready){document.querySelector('#startup-status').textContent='加载时间较长，请稍后重试';document.querySelector('#startup-retry').hidden=false;}},12000);
document.querySelector('#startup-retry').addEventListener('click',()=>location.reload());
// Normal startup lasts about two seconds including the 500 ms fade.
// If initialization takes longer, keep the launch screen until the planner is ready.
window.addEventListener('yantu-planner-ready',()=>{if(ready)return;ready=true;clearTimeout(slow);const totalMs=2000,fadeMs=500;setTimeout(()=>{splash.classList.add('startup-exit');setTimeout(()=>splash.remove(),fadeMs);},Math.max(0,totalMs-fadeMs-(performance.now()-started)));},{once:true});
})();
