import fs from 'node:fs';
import path from 'node:path';
/** Prevent respawned adapters from opening SQLite while offline restore owns it. */
export function assertNoRestore(database:string){
 for(const directory of [path.dirname(database),path.dirname(path.dirname(database))]){
  const marker=path.join(directory,'maintenance-active.json');if(!fs.existsSync(marker))continue;
  const value=JSON.parse(fs.readFileSync(marker,'utf8')) as {pid:number};
  if(!Number.isSafeInteger(value.pid)||value.pid<=0)throw Error('Invalid maintenance owner; database not opened');
  if(value.pid===process.pid)continue;
  let alive=true;try{process.kill(value.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;}
  if(alive)throw Error('Gateway restore is in progress; database not opened');
 }
}
