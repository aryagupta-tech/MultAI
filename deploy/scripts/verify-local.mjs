// Synthetic deployment-image verification. No cloud calls or published TCP ports.
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const id=randomUUID().replaceAll('-','');
const network=`multai-deploy-smoke-${id}`;
const database=`${network}-db`;
const backend=`${network}-api`;
const folder=await mkdtemp(path.join(tmpdir(),'multai-deploy-secrets-'));
let step='private secret fixture';
let networkCreated=false;
const started=[];
const ageDirectory=process.env.AGE_BIN_DIRECTORY;
function docker(args,options={}){return execFileSync('docker',args,{encoding:'utf8',stdio:['pipe','pipe','pipe'],...options}).trim();}
async function ready(container,command){
  for(let attempt=0;attempt<60;attempt++){
    try{docker(['exec',container,...command]);return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new Error('Readiness timeout');
}
const queryPrefix=`import pg from 'pg';import{readFileSync}from'node:fs';const url=new URL('postgresql://multai_app@database:5432/multai');url.password=readFileSync('/run/secrets/db-app-password','utf8').trim();const db=new pg.Client({connectionString:url.href});await db.connect();try{`;
const querySuffix='}finally{await db.end()}';
function sql(body){return docker(['exec','-i',backend,'node','--input-type=module'],{input:queryPrefix+body+querySuffix});}
try{
  await chmod(folder,0o700);
  for(const name of ['db-admin-password','db-app-password','google-client-id','google-client-secret']){
    const value=name.startsWith('db-')?randomBytes(32).toString('hex'):`synthetic-${name}`;
    await writeFile(path.join(folder,name),value+'\n',{mode:0o444});
  }
  step='private isolated network';
  docker(['network','create','--internal',network]);networkCreated=true;
  step='unprivileged database bootstrap';
  docker(['run','--detach','--rm','--name',database,'--network',network,'--network-alias','database','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','postgres',
    '--tmpfs','/var/lib/postgresql:rw,noexec,nosuid,nodev,size=256m,mode=1777','--tmpfs','/var/run/postgresql:rw,noexec,nosuid,nodev,size=16m,mode=1777','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777',
    '-v',`${folder}/db-admin-password:/run/secrets/db-admin-password:ro`,'-v',`${folder}/db-app-password:/run/secrets/db-app-password:ro`,
    '-e','POSTGRES_USER=multai_admin','-e','POSTGRES_DB=multai','-e','POSTGRES_PASSWORD_FILE=/run/secrets/db-admin-password','multai-database:deployment-validation','postgres','-c','log_min_error_statement=panic']);
  started.push(database);
  await ready(database,['pg_isready','-U','multai_admin','-d','multai']);
  step='compiled API startup with private mounted credentials';
  const mounts=['db-app-password','google-client-id','google-client-secret'].flatMap(name=>['-v',`${folder}/${name}:/run/secrets/${name}:ro`]);
  docker(['run','--detach','--rm','--name',backend,'--network',network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','1000:1000','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777',
    ...mounts,'-e','NODE_ENV=production','-e','HOST=0.0.0.0','-e','PORT=4310','-e','PUBLIC_ORIGIN=https://collaboration.example.invalid','multai-backend:deployment-validation']);
  started.push(backend);
  const health=['node','-e',"fetch('http://127.0.0.1:4310/health/ready').then(async r=>{const b=await r.json();if(!r.ok||b.database!=='ready'||b.identity!=='configured_unverified')process.exit(1)}).catch(()=>process.exit(1))"];
  await ready(backend,health);
  step='least-privilege database role and migration evidence';
  const role=JSON.parse(sql("const r=await db.query(\"SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user\");const m=await db.query('SELECT count(*)::int AS count FROM schema_migrations');console.log(JSON.stringify({role:r.rows[0],migrations:m.rows[0].count}));"));
  if(role.role.rolsuper||role.role.rolcreatedb||role.role.rolcreaterole||role.migrations<3)throw new Error('Role/migration check failed');
  step='synthetic running-execution fixture';
  const [user,workspace,device,auth,session,run,instruction,connection]=Array.from({length:8},()=>randomUUID());
  sql(`await db.query('BEGIN');await db.query('INSERT INTO users(id,google_sub,display_name) VALUES($1,$2,$3)',[${JSON.stringify(user)},'synthetic-container-sub','Synthetic container person']);await db.query('INSERT INTO workspaces(id,owner_id,name) VALUES($1,$2,$3)',[${JSON.stringify(workspace)},${JSON.stringify(user)},'Synthetic workspace']);await db.query('INSERT INTO devices(id,user_id,name) VALUES($1,$2,$3)',[${JSON.stringify(device)},${JSON.stringify(user)},'Synthetic device']);await db.query("INSERT INTO auth_sessions(id,user_id,device_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[${JSON.stringify(auth)},${JSON.stringify(user)},${JSON.stringify(device)}]);await db.query("INSERT INTO sessions(id,workspace_id,owner_id,host_device_id,status,runtime_generation) VALUES($1,$2,$3,$4,'running',1)",[${JSON.stringify(session)},${JSON.stringify(workspace)},${JSON.stringify(user)},${JSON.stringify(device)}]);await db.query("INSERT INTO execution_runs(id,session_id,request_id,fingerprint,owner_id,device_id,auth_session_id,instruction_id,connection_id,model,generation,service_epoch,lease_hash,lease_expires_at,status) VALUES($1,$2,$1,$3,$4,$5,$6,$7,$8,'synthetic-model',1,$1,$3,now()+interval '30 seconds','running')",[${JSON.stringify(run)},${JSON.stringify(session)},'${'0'.repeat(64)}',${JSON.stringify(user)},${JSON.stringify(device)},${JSON.stringify(auth)},${JSON.stringify(instruction)},${JSON.stringify(connection)}]);await db.query('COMMIT');`);
  step='actual process restart authority fencing';
  docker(['restart','--timeout','3',backend]);
  await ready(backend,health);
  const recovered=JSON.parse(sql(`const r=await db.query('SELECT status FROM execution_runs WHERE id=$1',[${JSON.stringify(run)}]);const s=await db.query('SELECT status,runtime_generation FROM sessions WHERE id=$1',[${JSON.stringify(session)}]);console.log(JSON.stringify({run:r.rows[0],session:s.rows[0]}));`));
  if(recovered.run.status!=='uncertain'||recovered.session.status!=='paused'||recovered.session.runtime_generation!==2)throw new Error('Restart did not fence authority');
  console.log('Local deployment images passed: unprivileged/read-only startup, least-privilege PostgreSQL, migrations, distinct OAuth readiness, and actual restart-to-uncertain recovery.');
  if(ageDirectory){
    step='temporary age identity generation';
    const age=path.join(ageDirectory,'age');
    const keygen=path.join(ageDirectory,'age-keygen');
    const key=path.join(folder,'offline-test-identity.key');
    const wrongKey=path.join(folder,'wrong-offline-test-identity.key');
    execFileSync(keygen,['--output',key],{stdio:'ignore'});
    execFileSync(keygen,['--output',wrongKey],{stdio:'ignore'});
    await chmod(key,0o600);await chmod(wrongKey,0o600);
    const recipient=execFileSync(keygen,['-y',key],{encoding:'utf8'}).trim();
    step='bounded synthetic PostgreSQL encrypted snapshot';
    const dump=execFileSync('docker',['exec',database,'pg_dump','-U','multai_admin','-d','multai','--format=custom','--no-owner','--no-acl'],{maxBuffer:268435456,stdio:['ignore','pipe','pipe']});
    const backup=path.join(folder,'synthetic.dump.age');
    execFileSync(age,['--encrypt','--recipient',recipient,'--output',backup],{input:dump,stdio:['pipe','ignore','pipe']});
    dump.fill(0);
    const encrypted=await import('node:fs/promises').then(fs=>fs.readFile(backup));
    const digest=createHash('sha256').update(encrypted).digest('hex');
    await writeFile(backup+'.sha256',digest+'\n',{mode:0o600});
    const restore=fileURLToPath(new URL('./restore-drill.sh',import.meta.url));
    const environment={...process.env,PATH:ageDirectory+path.delimiter+process.env.PATH};
    step='matching-key real isolated restore';
    execFileSync('bash',[restore,backup,key],{env:environment,stdio:['ignore','pipe','pipe']});
    step='wrong-key refusal';
    let denied=false;
    try{execFileSync('bash',[restore,backup,wrongKey],{env:environment,stdio:['ignore','pipe','pipe']});}catch{denied=true;}
    if(!denied)throw new Error('Wrong identity was accepted');
    step='encrypted checksum refusal';
    encrypted[0]^=1;
    await writeFile(backup,encrypted,{mode:0o600});
    denied=false;
    try{execFileSync('bash',[restore,backup,key],{env:environment,stdio:['ignore','pipe','pipe']});}catch{denied=true;}
    if(!denied)throw new Error('Corrupted backup was accepted');
    console.log('Synthetic encrypted PostgreSQL restoration passed with the matching age key; wrong key and modified ciphertext were rejected.');
  }
  console.log('No public ports, real OAuth credentials, cloud resources or provider inference were used.');
}catch{
  console.error(`Local deployment verification failed at: ${step}. No cloud resource was created.`);
  process.exitCode=1;
}finally{
  for(const container of started.reverse()){try{docker(['stop','--timeout','3',container]);}catch{}}
  if(networkCreated){try{docker(['network','rm',network]);}catch{}}
  await rm(folder,{recursive:true,force:true});
}
