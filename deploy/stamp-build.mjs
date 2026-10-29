import {createHash} from 'node:crypto';
import {readdir,readFile,writeFile} from 'node:fs/promises';

if(!/^[a-f0-9]{40}$/.test(process.env.SOURCE_COMMIT??'')) throw new Error('Build requires the reviewed SOURCE_COMMIT.');
if(!['true','false'].includes(process.env.SOURCE_DIRTY??'')) throw new Error('SOURCE_DIRTY must be explicit.');
const root=new URL('../',import.meta.url);
const files=[];
for(const directory of ['apps/backend/dist/','apps/backend/migrations/']){
  for(const name of (await readdir(new URL(directory,root))).sort()){
    if(name==='build-manifest.json')continue;
    const content=await readFile(new URL(directory+name,root));
    files.push({path:directory+name,bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')});
  }
}
const lock=await readFile(new URL('package-lock.json',root));
await writeFile(new URL('apps/backend/dist/build-manifest.json',root),JSON.stringify({product:'MultAI',component:'collaboration-service',version:'0.0.0-dev.1',developmentBuild:true,sourceCommit:process.env.SOURCE_COMMIT,sourceDirty:process.env.SOURCE_DIRTY==='true',builtAt:new Date().toISOString(),node:process.version,lockSha256:createHash('sha256').update(lock).digest('hex'),files},null,2)+'\n');
