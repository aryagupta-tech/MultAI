import {readFile} from 'node:fs/promises';

async function secret(name){
  const bytes=await readFile(`/run/secrets/${name}`);
  if(bytes.length>4096)throw new Error('Invalid deployment secret.');
  const value=bytes.toString('utf8').trim();
  if(!value||/[\u0000-\u001f]/u.test(value)||/^<.*>$/.test(value))throw new Error('Invalid deployment secret.');
  return value;
}
try{
  const password=await secret('db-app-password');
  if(!/^[a-f0-9]{64}$/.test(password))throw new Error('Invalid deployment database secret.');
  const database=new URL('postgresql://multai_app@database:5432/multai');
  database.password=password;
  process.env.DATABASE_URL=database.href;
  process.env.GOOGLE_CLIENT_ID=await secret('google-client-id');
  process.env.GOOGLE_CLIENT_SECRET=await secret('google-client-secret');
  process.env.DESKTOP_CALLBACK_URI='multai-dev://auth/callback';
  await import('./dist/index.js');
}catch{
  process.stderr.write('Deployment configuration could not be loaded. Check the private secret mounts and service origin.\n');
  process.exitCode=1;
}
