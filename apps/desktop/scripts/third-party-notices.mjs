// Offline notice collection for the installed production dependency closure.
// Reads this checkout's package manifests/license files only; never global profiles.
import {createHash} from 'node:crypto';
import {readFile,readdir,realpath,stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(import.meta.url);
const defaultDesktop=path.dirname(path.dirname(script));
const within=(parent,child)=>child===parent||child.startsWith(parent+path.sep);
const namePattern=/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const noticePattern=/^(?:licen[cs]e|copying|copyright|notice)(?:$|[._-])/i;
// These ws native accelerators are explicit build-electron externals and are not
// staged. The bundled ws implementation uses its JavaScript fallback instead.
const excludedOptionalPeers=new Set(['bufferutil','utf-8-validate']);

async function textFile(file){
  const info=await stat(file);
  if(!info.isFile()||info.size>1_048_576)throw new Error('A license/notice file is missing, nonregular or oversized.');
  const value=new TextDecoder('utf-8',{fatal:true}).decode(await readFile(file));
  if(!value.trim()||value.includes('\0'))throw new Error('A license/notice file is empty or binary.');
  return value;
}

function declaredLicense(manifest){
  if(typeof manifest.license==='string'&&manifest.license.trim())return manifest.license.trim();
  if(typeof manifest.license?.type==='string')return manifest.license.type;
  if(Array.isArray(manifest.licenses)&&manifest.licenses.length&&manifest.licenses.every(value=>typeof value.type==='string'&&value.type.trim()))return manifest.licenses.map(value=>value.type).join(' OR ');
  throw new Error(`Missing declared license for ${manifest.name}@${manifest.version}; review before packaging.`);
}

/** Returns notice content and public metadata; it does not write or execute package code. */
export async function createThirdPartyNotices({desktopRoot=defaultDesktop,repositoryRoot=path.resolve(defaultDesktop,'../..')}={}){
  const repository=await realpath(repositoryRoot);
  const desktop=await realpath(desktopRoot);
  if(!within(repository,desktop))throw new Error('The desktop source must belong to this repository.');
  const rootLicense=await textFile(path.join(repository,'LICENSE'));
  const rootManifest=JSON.parse(await readFile(path.join(repository,'package.json'),'utf8'));
  if(declaredLicense(rootManifest)!=='MIT')throw new Error('Review the selected repository license before packaging internal workspace code.');
  const seen=new Set();
  const records=[];

  async function resolveDependency(name,parent,optional){
    if(!namePattern.test(name))throw new Error('Invalid dependency name in the installed package closure.');
    const require=createRequire(path.join(parent,'package.json'));
    // package.json export maps may forbid require.resolve('name/package.json').
    // Follow Node's node_modules search order while filtering out every global path.
    for(const modules of require.resolve.paths(name)??[]){
      if(!within(repository,path.resolve(modules)))continue;
      const candidate=path.join(modules,...name.split('/'),'package.json');
      let manifestFile;
      try{manifestFile=await realpath(candidate);}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')continue;throw error;}
      const folder=path.dirname(manifestFile);
      const internal=name.startsWith('@multai/')&&within(path.join(repository,'packages'),folder);
      if(!within(repository,folder)||(!internal&&!folder.split(path.sep).includes('node_modules')))throw new Error(`Dependency ${name} resolves outside this checkout's installed dependency tree.`);
      return folder;
    }
    if(optional)return null;
    throw new Error(`Production dependency ${name} is not installed in this checkout; run the locked npm installation before packaging.`);
  }

  async function visit(folder){
    folder=await realpath(folder);
    if(seen.has(folder))return;
    if(seen.size>=512)throw new Error('The production notice closure exceeds the reviewed package bound.');
    seen.add(folder);
    const manifest=JSON.parse(await readFile(path.join(folder,'package.json'),'utf8'));
    if(typeof manifest.name!=='string'||!namePattern.test(manifest.name)||typeof manifest.version!=='string')throw new Error('An installed package manifest lacks a valid name or version.');
    const internal=manifest.name.startsWith('@multai/')&&within(repository,folder)&&!folder.split(path.sep).includes('node_modules');
    const license=declaredLicense(manifest);
    const notices=[];
    if(internal){
      if(license!=='MIT')throw new Error(`Internal package ${manifest.name} does not match the selected root MIT license.`);
      notices.push({name:'repository LICENSE',content:rootLicense});
    }else{
      for(const entry of (await readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
        if(!noticePattern.test(entry.name))continue;
        const source=await realpath(path.join(folder,entry.name));
        if(!within(folder,source))throw new Error(`A notice for ${manifest.name} leaves its installed package directory.`);
        if(entry.isFile()||entry.isSymbolicLink())notices.push({name:entry.name,content:await textFile(source)});
      }
      if(!notices.some(notice=>/^(?:licen[cs]e|copying)/i.test(notice.name)))throw new Error(`No full installed LICENSE/COPYING text found for ${manifest.name}@${manifest.version}; review before packaging.`);
    }
    records.push({name:manifest.name,version:manifest.version,license,internal,notices});
    const dependencies={...(manifest.dependencies??{}),...(manifest.optionalDependencies??{})};
    for(const name of Object.keys(dependencies).sort()){
      const resolved=await resolveDependency(name,folder,Object.hasOwn(manifest.optionalDependencies??{},name));
      if(resolved)await visit(resolved);
    }
    for(const name of Object.keys(manifest.peerDependencies??{}).sort()){
      if(name.startsWith('@types/')||excludedOptionalPeers.has(name))continue;
      const resolved=await resolveDependency(name,folder,manifest.peerDependenciesMeta?.[name]?.optional===true);
      if(resolved)await visit(resolved);
    }
  }

  await visit(desktop);
  records.sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version));
  const lines=[
    'MultAI desktop — license and third-party notices',
    '',
    'This file contains the full installed license/notice texts for the desktop production dependency closure, including internal MultAI workspace code.',
    'Installed runtime peers are included conservatively. Development-only packages and the explicitly unbundled ws native accelerators are excluded.',
    'Electron/Chromium vendor licenses and notices are supplied separately by the Electron distribution.',
    '',
    'Index (name | installed version | declared SPDX/license expression):',
    ...records.map(record=>`${record.name} | ${record.version} | ${record.license}`),
    '',
  ];
  for(const record of records){
    lines.push('='.repeat(78),`${record.name}@${record.version}`,`Declared SPDX/license: ${record.license}`,record.internal?'Internal MultAI workspace; the selected repository LICENSE applies.':'Installed third-party package.','');
    for(const notice of record.notices)lines.push(`--- ${notice.name} ---`,notice.content.trimEnd(),'');
  }
  const content=lines.join('\n')+'\n';
  return {content,packages:records.map(({name,version,license,internal,notices})=>({name,version,license,internal,noticeFiles:notices.map(notice=>notice.name)})),sha256:createHash('sha256').update(content).digest('hex')};
}

if(process.argv[1]&&path.resolve(process.argv[1])===script){
  try{
    const report=await createThirdPartyNotices();
    console.log(JSON.stringify({packages:report.packages,noticeBytes:Buffer.byteLength(report.content),sha256:report.sha256},null,2));
  }catch(error){
    console.error(`Third-party notice validation failed: ${error.message}`);
    process.exitCode=1;
  }
}
