// A local search index of a session's files, for @codebase and the agent's codebase_search tool. SQLite
// FTS5 ranks overlapping chunks with BM25. Identifiers are also indexed as words (cartTotal and
// cart_total as "cart total"), so a description in plain words finds the code that implements it.
// Built per session on this computer from the worktree; nothing leaves it.
import {DatabaseSync} from 'node:sqlite';
import {lstat,readFile} from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_BYTES=256*1024;
const MAX_FILES=20_000;
const CHUNK_LINES=60;
const OVERLAP=10;
const STOP=new Set(['the','and','for','with','that','this','from','into','where','what','when','which','how','does','are','is','to','of','in','on','it','be','a','an','or','by','as','at','do','we','i','you','code','file','files','function','find','show','me','please']);

export interface CodeChunk {path:string;start:number;end:number;text:string}

/** Words inside identifiers: cartTotal → "cart total", HTTPServer → "http server", cart_total → "cart total". */
export function identifierWords(text:string):string {
  return (text.match(/[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*/gu)??[])
    .filter(word=>/[a-z][A-Z]|_|[A-Z]{2}[a-z]/u.test(word))
    .map(word=>word.replace(/_/gu,' ').replace(/([a-z0-9])([A-Z])/gu,'$1 $2').replace(/([A-Z]+)([A-Z][a-z])/gu,'$1 $2').toLowerCase())
    .join(' ');
}

export function chunkText(text:string):{start:number;end:number;body:string}[] {
  const lines=text.split('\n');const chunks=[];
  for(let start=0;start<lines.length;start+=CHUNK_LINES-OVERLAP){
    const end=Math.min(lines.length,start+CHUNK_LINES);
    const body=lines.slice(start,end).join('\n');
    if(body.trim())chunks.push({start:start+1,end,body});
    if(end>=lines.length)break;
  }
  return chunks;
}

/** Search terms from a request in plain words or identifiers, as an FTS5 OR query. */
export function searchTerms(query:string):string[] {
  const words=`${query} ${identifierWords(query)}`.toLowerCase().match(/[a-z0-9]{2,}/gu)??[];
  return [...new Set(words.filter(word=>!STOP.has(word)))].slice(0,24);
}

export class CodeIndex {
  private readonly db:DatabaseSync;
  private refreshed=0;
  constructor(file:string){
    this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,size INTEGER NOT NULL,mtime REAL NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(path UNINDEXED,start UNINDEXED,end UNINDEXED,body,words,tokenize='porter unicode61');`);
  }
  /** Brings the index up to date with `files` (relative to root), reading only files that changed. */
  async refresh(root:string,files:readonly string[],options:{maxAgeMs?:number}={}):Promise<{indexed:number;changed:number}>{
    if(options.maxAgeMs&&Date.now()-this.refreshed<options.maxAgeMs)return {indexed:this.count(),changed:0};
    const known=new Map((this.db.prepare('SELECT path,size,mtime FROM files').all() as {path:string;size:number;mtime:number}[]).map(row=>[row.path,row]));
    const wanted=new Set<string>();let changed=0;
    const remove=this.db.prepare('DELETE FROM chunks WHERE path=?');
    const insert=this.db.prepare('INSERT INTO chunks(path,start,end,body,words) VALUES(?,?,?,?,?)');
    const upsert=this.db.prepare('INSERT INTO files(path,size,mtime) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET size=excluded.size,mtime=excluded.mtime');
    for(const file of files.slice(0,MAX_FILES)){
      const stat=await lstat(path.join(root,file)).catch(()=>null);
      if(!stat?.isFile()||stat.size>MAX_FILE_BYTES)continue;
      wanted.add(file);
      const previous=known.get(file);
      if(previous&&previous.size===stat.size&&previous.mtime===stat.mtimeMs)continue;
      const text=await readFile(path.join(root,file),'utf8').catch(()=>null);
      this.db.exec('BEGIN');
      try{
        remove.run(file);
        // Binary or unreadable files are remembered so they aren't read again, but get no chunks.
        if(text!==null&&!text.includes('\u0000'))for(const chunk of chunkText(text))insert.run(file,chunk.start,chunk.end,chunk.body,`${identifierWords(`${file} ${chunk.body}`)} ${file.replace(/[/._-]+/gu,' ')}`);
        upsert.run(file,stat.size,stat.mtimeMs);
        this.db.exec('COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
      changed++;
    }
    for(const file of known.keys())if(!wanted.has(file)){remove.run(file);this.db.prepare('DELETE FROM files WHERE path=?').run(file);changed++;}
    this.refreshed=Date.now();
    return {indexed:wanted.size,changed};
  }
  search(query:string,limit=8):CodeChunk[]{
    const terms=searchTerms(query);
    if(!terms.length)return [];
    const match=terms.map(term=>`"${term}"`).join(' OR ');
    // Matches in identifiers and paths (words) count less than in the code itself.
    const rows=this.db.prepare('SELECT path,start,end,body FROM chunks WHERE chunks MATCH ? ORDER BY bm25(chunks,0,0,0,1.0,0.6) LIMIT ?').all(match,limit*3) as {path:string;start:number;end:number;body:string}[];
    // At most two chunks per file, so one long file doesn't crowd out the rest.
    const perFile=new Map<string,number>();const results:CodeChunk[]=[];
    for(const row of rows){
      const count=perFile.get(row.path)??0;if(count>=2)continue;
      perFile.set(row.path,count+1);results.push({path:row.path,start:row.start,end:row.end,text:row.body});
      if(results.length>=limit)break;
    }
    return results;
  }
  private count():number {return (this.db.prepare('SELECT count(*) AS n FROM files').get() as {n:number}).n;}
  close():void {this.db.close();}
}
