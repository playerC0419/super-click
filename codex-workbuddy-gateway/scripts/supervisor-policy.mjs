export function ownsProcess(row,node,entry){const normalize=s=>String(s??'').replaceAll('\\','/').toLowerCase();return normalize(row?.exe)===normalize(node)&&normalize(row?.commandLine).includes(normalize(entry));}
export function nextDelay(failures){return Math.min(60_000,1000*2**Math.min(failures,6));}
export function recoveryDecision({exists,healthy,idle,failures,lastAttempt,now}){if(healthy)return 'healthy';if(now-lastAttempt<nextDelay(failures))return 'backoff';if(!exists)return 'start';return idle?'restart':'attention';}
