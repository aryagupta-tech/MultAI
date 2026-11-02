import {describe,it,expect} from 'vitest';
import {conflictContextSchema,conflictPrompt,parseConflictAnalysis} from './conflicts';
import type {ConflictContext} from '../../src/bridge/conflicts';
const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
const context:ConflictContext={fingerprint:'a'.repeat(64),requiresReview:true,pending:[{id:first,authorId:first,authorName:'Host',text:'Allow guests',revision:1},{id:second,authorId:second,authorName:'Teammate',text:'Require accounts',revision:2}]};
const analysis={summary:'Possible checkout conflict.',possibleConflicts:[{instructionIds:[first,second],explanation:'Guest versus required sign-in.'}],options:[{label:'Guest checkout',text:'Allow guest checkout.'}]};
describe('conflict advice boundary',()=>{
  it('keeps author and source identities as data and permits compatible directions',()=>{
    expect(JSON.parse(conflictPrompt(context)).directions[1]).toEqual({id:second,authorName:'Teammate',text:'Require accounts'});
    expect(parseConflictAnalysis(JSON.stringify({...analysis,possibleConflicts:[]}),context)?.possibleConflicts).toEqual([]);
    expect(parseConflictAnalysis('```json\n'+JSON.stringify(analysis)+'\n```',context)).toEqual(analysis);
    const continued={...context,pending:[context.pending[1]!],previousDirection:{id:first,authorId:first,authorName:'Host',text:'Allow guests'}};
    expect(parseConflictAnalysis(JSON.stringify(analysis),continued)).toEqual(analysis);
    expect(JSON.parse(conflictPrompt(continued)).previousDirection.text).toBe('Allow guests');
  });
  it('refuses invented IDs, duplicates, empty explanations and authority fields',()=>{
    for(const value of [
      {...analysis,possibleConflicts:[{instructionIds:[first,'33333333-3333-4333-8333-333333333333'],explanation:'Invented'}]},
      {...analysis,possibleConflicts:[{instructionIds:[first,first],explanation:'Duplicate'}]},
      {...analysis,possibleConflicts:[{instructionIds:[first,second],explanation:''}]},
      {...analysis,approved:true},
    ])expect(parseConflictAnalysis(JSON.stringify(value),context)).toBeNull();
  });
  it('rejects malformed and excessive output rather than extracting arbitrary JSON',()=>{
    expect(parseConflictAnalysis('Sure: '+JSON.stringify(analysis),context)).toBeNull();
    expect(parseConflictAnalysis('{',context)).toBeNull();
    expect(parseConflictAnalysis(JSON.stringify({...analysis,summary:'x'.repeat(25000)}),context)).toBeNull();
    expect(()=>conflictContextSchema.parse({...context,fingerprint:'x'})).toThrow();
    expect(()=>conflictContextSchema.parse({...context,pending:Array(101).fill(context.pending[0])})).toThrow();
  });
});
