import {mkdtemp,mkdir,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {fitJpeg,loopbackUrl,outlineScript,privatePath,serveWorkspace,servedFile} from './look';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
async function project(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'multai-look-')));
  const outside=await realpath(await mkdtemp(join(tmpdir(),'multai-look-outside-')));
  cleanup.push(()=>rm(root,{recursive:true,force:true}),()=>rm(outside,{recursive:true,force:true}));
  await mkdir(join(root,'public/img'),{recursive:true});await mkdir(join(root,'.git'));await mkdir(join(root,'node_modules/lib'),{recursive:true});
  await writeFile(join(root,'index.html'),'<h1>Shop</h1><script type="module" src="cart.js"></script>');
  await writeFile(join(root,'cart.js'),'export const total = 1;');
  await writeFile(join(root,'public/index.html'),'<p>public</p>');
  await writeFile(join(root,'public/img/logo.png'),Buffer.from([0x89,0x50,0x4e,0x47]));
  await writeFile(join(root,'node_modules/lib/index.js'),'export default 1;');
  await writeFile(join(root,'.env'),'TOKEN=secret');await writeFile(join(root,'.git/config'),'[core]');await writeFile(join(root,'server.pem'),'key');
  await writeFile(join(outside,'secret.txt'),'outside');
  await symlink(join(outside,'secret.txt'),join(root,'escape.txt'));
  await symlink(join(root,'.env'),join(root,'env.txt'));
  return root;
}

describe('looking at the app',()=>{
  it('opens only pages on this computer',()=>{
    expect(loopbackUrl('index.html')).toBeNull();
    expect(loopbackUrl('public/cart.html')).toBeNull();
    expect(loopbackUrl('http://localhost:5173/cart')?.href).toBe('http://localhost:5173/cart');
    expect(loopbackUrl('http://127.0.0.1:3000')?.port).toBe('3000');
    expect(loopbackUrl('https://[::1]:8443/')?.hostname).toBe('[::1]');
    for(const page of ['https://example.com','http://localhost.example.com','http://user:pw@localhost:3000','file:///etc/passwd','javascript:alert(1)','http://10.0.0.2:3000','http://169.254.169.254/'])expect(()=>loopbackUrl(page),page).toThrow(/Only pages on this computer/u);
  });

  it('serves the workspace\'s pages, scripts, images and packages, never private files, traversal or links out of it',async()=>{
    const root=await project();
    expect(await servedFile(root,'/')).toBe(join(root,'index.html'));
    expect(await servedFile(root,'/public')).toBe(join(root,'public/index.html'));
    expect(await servedFile(root,'/public/img/logo.png?v=2')).toBe(join(root,'public/img/logo.png'));
    expect(await servedFile(root,'/node_modules/lib/index.js')).toBe(join(root,'node_modules/lib/index.js'));
    for(const request of ['/.env','/.git/config','/server.pem','/../etc/passwd','/%2e%2e/%2e%2e/etc/passwd','/escape.txt','/env.txt','/missing.html','/%E0%A4%A','/a%00.html'])expect(await servedFile(root,request),request).toBeNull();
    expect(privatePath('config/credentials.json')).toBe(true);
    expect(privatePath('src/id_ed25519')).toBe(true);
    expect(privatePath('src/app.js')).toBe(false);
  });

  it('answers over loopback with content types, read-only, and closes',async()=>{
    const root=await project();
    const server=await serveWorkspace(root);
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    const page=await fetch(`${server.origin}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/u);
    expect(await page.text()).toContain('<h1>Shop</h1>');
    expect((await fetch(`${server.origin}/cart.js`)).headers.get('content-type')).toMatch(/^text\/javascript/u);
    expect((await fetch(`${server.origin}/.env`)).status).toBe(404);
    expect((await fetch(`${server.origin}/index.html`,{method:'POST',body:'x'})).status).toBe(405);
    await server.close();
    await expect(fetch(`${server.origin}/`)).rejects.toThrow();
  });

  it('fits screenshots to a byte budget, smaller quality first and then smaller size',()=>{
    const sizes:string[]=[];
    const encode=(width:number,quality:number)=>{sizes.push(`${width}@${quality}`);return Buffer.alloc(width*quality/10);};
    const url=fitJpeg(encode,6000,[1024,768],[72,45]);
    expect(sizes).toEqual(['1024@72','1024@45','768@72','768@45']);
    expect(url.length).toBeLessThanOrEqual(6000);
    expect(()=>fitJpeg(()=>Buffer.alloc(100_000),1000,[320],[40])).toThrow(/small enough/u);
  });

  it('outlines boxes from numbers only',()=>{
    const script=outlineScript([{x1:10,y1:20,x2:109,y2:59}]);
    expect(script).toContain('[{"x1":10,"y1":20,"x2":109,"y2":59}]');
    expect(()=>new Function(script)).not.toThrow();
  });
});
