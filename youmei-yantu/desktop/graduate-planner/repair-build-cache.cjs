const path=require('node:path');
const {computeCacheMetadata,writeCacheState,CacheState}=require('app-builder-lib/out/util/cacheState');
const fs=require('node:fs/promises');
(async()=>{
const dir=path.join(__dirname,'.cache-builder/nsis-3.0.4.1/nsis-3.0.4.1-w8az6');
await fs.access(path.join(dir,'Bin/makensis.exe'));
const metadata=await computeCacheMetadata(dir);
await writeCacheState(dir,CacheState.complete,metadata,true);
console.log(metadata);
})();
