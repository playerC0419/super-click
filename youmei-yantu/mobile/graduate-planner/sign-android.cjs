const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=__dirname,folder=path.join(root,'signing');fs.mkdirSync(folder,{recursive:true});
const configPath=path.join(folder,'private-signing-info.json');
let info;if(fs.existsSync(configPath))info=JSON.parse(fs.readFileSync(configPath,'utf8'));else{info={alias:'yantu',password:crypto.randomBytes(32).toString('base64url')};fs.writeFileSync(configPath,JSON.stringify(info),{mode:0o600});}
const env={...process.env,YANTU_SIGNING_PASSWORD:info.password},key=path.join(folder,'yantu-release.p12');
function run(cmd,args){const result=spawnSync(cmd,args,{env,stdio:'pipe',encoding:'utf8',shell:false,windowsHide:true});if(result.status!==0)throw Error(result.stderr||result.stdout||result.error);}
if(!fs.existsSync(key))run(path.join(env.JAVA_HOME,'bin/keytool.exe'),['-genkeypair','-keystore',key,'-storetype','PKCS12','-alias',info.alias,'-storepass:env','YANTU_SIGNING_PASSWORD','-keypass:env','YANTU_SIGNING_PASSWORD','-keyalg','RSA','-keysize','3072','-validity','10000','-dname','CN=Yantu Planner']);
const build=path.resolve(root,'../../mobile-tools/android-sdk/build-tools/36.0.0');
const unsigned=path.join(root,'android/app/build/outputs/apk/release/app-release-unsigned.apk');
const out=path.resolve(root,'../../outputs/masters_timeline/mobile');fs.mkdirSync(out,{recursive:true});
const aligned=path.join(root,'android/app/build/outputs/apk/release/app-release-aligned.apk'),apk=path.join(out,'Youmei-Yantu-1.0.2-android.apk');
run(path.join(build,'zipalign.exe'),['-f','-P','16','4',unsigned,aligned]);
const signer=path.join(build,'lib/apksigner.jar');
run(path.join(env.JAVA_HOME,'bin/java.exe'),['-jar',signer,'sign','--ks',key,'--ks-key-alias',info.alias,'--ks-pass','env:YANTU_SIGNING_PASSWORD','--key-pass','env:YANTU_SIGNING_PASSWORD','--out',apk,aligned]);
run(path.join(env.JAVA_HOME,'bin/java.exe'),['-jar',signer,'verify','--verbose','--print-certs',apk]);
fs.rmSync(apk+'.idsig',{force:true});
fs.writeFileSync(path.join(out,'SHA256SUMS.txt'),crypto.createHash('sha256').update(fs.readFileSync(apk)).digest('hex')+'  '+path.basename(apk)+'\n');
console.log(JSON.stringify({apk,bytes:fs.statSync(apk).size,signatureVerified:true,privateKeyFolder:folder}));
