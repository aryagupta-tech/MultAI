import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {CodeIndex,chunkText,identifierWords,searchTerms} from './codeindex';

const cleanup:string[]=[];
afterEach(async()=>{for(const directory of cleanup.splice(0))await rm(directory,{recursive:true,force:true});});

describe('code index',()=>{
  it('splits identifiers into words and requests into search terms',()=>{
    expect(identifierWords('const cartTotal = apply_discount(HTTPServer)')).toBe('cart total apply discount http server');
    expect(searchTerms('Where is the discount calculated?')).toEqual(['discount','calculated']);
    expect(searchTerms('applyCoupon')).toEqual(['applycoupon','apply','coupon']);
  });
  it('chunks with overlap and keeps line numbers',()=>{
    const text=Array.from({length:130},(_,i)=>`line ${i+1}`).join('\n');
    expect(chunkText(text).map(chunk=>[chunk.start,chunk.end])).toEqual([[1,60],[51,110],[101,130]]);
  });
  it('finds code by what it does, updates incrementally and forgets removed files',async()=>{
    const root=await mkdtemp(join(tmpdir(),'multai-index-'));cleanup.push(root);
    await mkdir(join(root,'src'));
    await writeFile(join(root,'src','cart.js'),'export function cartTotal(items){\n  return items.reduce((sum,item)=>sum+item.price*item.quantity,0);\n}\n');
    await writeFile(join(root,'src','pricing.js'),'// Percentage off for promotions\nexport function applyDiscount(total, percent){\n  return Math.round(total*(1-percent/100)*100)/100;\n}\n');
    await writeFile(join(root,'README.md'),'# Shop\nA tiny shop.\n');
    await writeFile(join(root,'logo.bin'),Buffer.from([0,1,2,3]));
    const index=new CodeIndex(join(root,'index.sqlite'));
    try{
      expect(await index.refresh(root,['src/cart.js','src/pricing.js','README.md','logo.bin'])).toEqual({indexed:4,changed:4});
      expect(index.search('where is the discount calculated').map(hit=>hit.path)).toEqual(['src/pricing.js']);
      expect(index.search('cart total')[0]).toMatchObject({path:'src/cart.js',start:1,end:4});
      expect(index.search('promotion')[0]?.path).toBe('src/pricing.js');
      // Nothing changed: nothing is read again.
      expect(await index.refresh(root,['src/cart.js','src/pricing.js','README.md','logo.bin'])).toMatchObject({changed:0});
      await writeFile(join(root,'src','cart.js'),'export function shippingFee(weight){\n  return weight>10?15:5;\n}\n');
      expect(await index.refresh(root,['src/cart.js','src/pricing.js'])).toMatchObject({indexed:2,changed:3});
      expect(index.search('quantity reduce')).toEqual([]);
      expect(index.search('shipping fee weight')[0]?.path).toBe('src/cart.js');
      expect(index.search('tiny shop')).toEqual([]);
    }finally{index.close();}
  });
});
