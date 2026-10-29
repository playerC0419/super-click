const fs=require('node:fs'),path=require('node:path');
const root=__dirname;
const properties=path.join(root,'android/gradle.properties');let text=fs.readFileSync(properties,'utf8');if(!text.includes('android.overridePathCheck'))text+='\nandroid.overridePathCheck=true\n';fs.writeFileSync(properties,text);
const wrapper=path.join(root,'android/gradle/wrapper/gradle-wrapper.properties');text=fs.readFileSync(wrapper,'utf8').replace('services.gradle.org/distributions/gradle-8.14.3-all.zip','downloads.gradle.org/distributions/gradle-8.14.3-bin.zip').replace('networkTimeout=10000','networkTimeout=120000');fs.writeFileSync(wrapper,text);
const sdk=path.resolve(root,'../../mobile-tools/android-sdk').replaceAll('\\','/');fs.writeFileSync(path.join(root,'android/local.properties'),'sdk.dir='+sdk+'\n');
const filePaths=path.join(root,'android/app/src/main/res/xml/file_paths.xml');fs.writeFileSync(filePaths,'<?xml version="1.0" encoding="utf-8"?><paths xmlns:android="http://schemas.android.com/apk/res/android"><cache-path name="exports" path="exports/" /></paths>');
const info=path.join(root,'ios/App/App/Info.plist');text=fs.readFileSync(info,'utf8');if(!text.includes('UIFileSharingEnabled'))text=text.replace('</dict>','<key>UIFileSharingEnabled</key><true/><key>LSSupportsOpeningDocumentsInPlace</key><true/></dict>');fs.writeFileSync(info,text);
console.log('Configured Android build paths and restricted shared file provider.');
