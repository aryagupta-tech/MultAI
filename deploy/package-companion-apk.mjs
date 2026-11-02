// Publish only the current reviewed release. Private signing files never enter the image context.
import {createHash} from 'node:crypto';
import {readFile,mkdir,readdir,stat,copyFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

const [releases,properties,companion]=process.argv.slice(2);
if(!releases||!properties||!companion)throw new Error('Expected release directory, version.properties and companion directory.');
const version=Object.fromEntries((await readFile(properties,'utf8')).trim().split('\n').map(line=>line.split('=')));
const file=`multai-companion-${version.versionName}.apk`;
if(!/^multai-companion-\d+\.\d+\.\d+\.apk$/u.test(file))throw new Error('Invalid Android release version.');
const manifest=JSON.parse(await readFile(path.join(releases,`${file}.json`),'utf8'));
if(manifest.file!==file||manifest.applicationId!=='si.multai.companion'||manifest.service!=='https://api.multai.si'
  ||manifest.versionName!==version.versionName||manifest.versionCode!==Number(version.versionCode)
  ||manifest.sourceDirty!==false||!/^[a-f0-9]{40}$/u.test(manifest.sourceCommit??'')
  ||manifest.signingCertificateSha256!=='72:E3:60:27:AE:1C:6C:A8:F9:75:A3:F8:95:EA:11:A6:78:84:80:FF:0C:19:B9:C9:F1:3F:1C:E7:7F:F3:7B:7B'){
  throw new Error('Android release provenance does not match the approved application.');
}
const apk=await readFile(path.join(releases,file));
const sha256=createHash('sha256').update(apk).digest('hex');
if(sha256!==manifest.sha256)throw new Error('Android release checksum mismatch.');
async function bytes(folder){let size=0;for(const entry of await readdir(folder,{withFileTypes:true})){const full=path.join(folder,entry.name);size+=entry.isDirectory()?await bytes(full):(await stat(full)).size;}return size;}
// The service reads at most 16 MiB of static assets. Fail the build before a large APK hides the app.
if(await bytes(companion)+apk.length+32768>16*1024*1024)throw new Error('Companion and Android release exceed the service static-asset bound.');
const downloads=path.join(companion,'downloads');await mkdir(downloads,{recursive:true});
await copyFile(path.join(releases,file),path.join(downloads,file));
await writeFile(path.join(downloads,`${file}.sha256`),`${sha256}  ${file}\n`);
await writeFile(path.join(downloads,`${file}.json`),`${JSON.stringify(manifest,null,2)}\n`);
await writeFile(path.join(downloads,'latest.json'),`${JSON.stringify({...manifest,url:`/app/downloads/${file}`},null,2)}\n`);
console.log(`Published verified Android ${manifest.versionName}, ${apk.length} bytes, SHA-256 ${sha256}`);
