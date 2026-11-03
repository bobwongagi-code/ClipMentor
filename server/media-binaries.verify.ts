import assert from 'node:assert/strict';
import {whisperCliBin} from './media-binaries';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
const original=Object.getOwnPropertyDescriptor(process,'resourcesPath'),override=process.env.OPENCHATCUT_WHISPER_CLI;
const relative=join('whisper-cli',`${process.platform}-${process.arch}`,`whisper-cli${process.platform==='win32'?'.exe':''}`);
const dev=join(import.meta.dirname,'..','public',relative);
try{
 delete process.env.OPENCHATCUT_WHISPER_CLI;
 Reflect.deleteProperty(process,'resourcesPath');assert.equal(typeof whisperCliBin(),'string','ordinary Node must not depend on Electron ambient globals');
 const expected=(resources:string)=>[dev,join(resources,'dist',relative),join(resources,relative)].find(existsSync)??dev;
 assert.equal(whisperCliBin(),expected(''),'missing Electron path preserves existing lookup order');
 let reads=0;Object.defineProperty(process,'resourcesPath',{configurable:true,get(){reads++;return '/synthetic-electron-resources';}});
 assert.equal(whisperCliBin(),expected('/synthetic-electron-resources'));assert(reads>0,'Electron runtime field is actually inspected');
 process.env.OPENCHATCUT_WHISPER_CLI='/synthetic/operator-override';assert.equal(whisperCliBin(),'/synthetic/operator-override','explicit override still wins');
 console.log('Media binaries: plain Node, optional Electron resources and override precedence passed; no binary/model execution.');
}finally{if(original)Object.defineProperty(process,'resourcesPath',original);else Reflect.deleteProperty(process,'resourcesPath');if(override===undefined)delete process.env.OPENCHATCUT_WHISPER_CLI;else process.env.OPENCHATCUT_WHISPER_CLI=override;}
