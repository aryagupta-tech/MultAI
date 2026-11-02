import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {VerificationPanel,BrowserReviewPanel,CriterionCard} from './VerificationPanel';
import type {SessionDetail} from '../model/types';
import type {AcceptanceCriterion} from '../bridge/review';
const session:SessionDetail={id:'11111111-1111-4111-8111-111111111111',source:'live',title:'Checkout',objective:'Avoid duplicate orders',mode:'build',status:'inactive',role:'owner',capabilities:{submit:true,approve:true,configure:true,decide:true,delete:true},hostName:'Host',hostOnline:true,baseline:'main',worktree:'private',model:{id:'fixture',label:'Fixture',engine:'fixture',reasoning:[]},reasoning:'medium',participants:[],timeline:[],decisions:[],changes:[]};
const criterion:AcceptanceCriterion={id:'22222222-2222-4222-8222-222222222222',text:'Double-click creates one order',checkCommand:'npm test -- checkout',version:2,state:'approved',authorId:'author',authorName:'Teammate',authorKind:'participant',status:'passed',evidence:{id:'33333333-3333-4333-8333-333333333333',criterionVersion:2,revision:'a'.repeat(64),kind:'command',command:'npm test -- checkout',exitCode:0,output:'Checkout regression passed',timedOut:false,canceled:false,durationMs:20,createdAt:'2030-01-01T00:00:00.000Z',reviews:[]}};
const card=(item:AcceptanceCriterion=criterion,d:SessionDetail=session,revision:string|null='a'.repeat(64))=>renderToStaticMarkup(<CriterionCard item={item} d={d} busy={false} currentRevision={revision} perform={async()=>undefined} edit={()=>undefined}/>);
const getButton=(html:string,label:string)=>[...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)].map(match=>match[0]).find(value=>value.includes(label));

describe('team review controls',()=>{
  it('does not expose execution or proposal controls to viewers, or verification actions in demo sessions',()=>{
    const viewer={...session,role:'viewer' as const,capabilities:{submit:false,approve:false,configure:false,decide:false,delete:false}};
    const html=renderToStaticMarkup(<VerificationPanel d={viewer}/>);
    expect(html).not.toContain('Run checks and reviewer');expect(html).not.toContain('Save proposal');
    const demo=renderToStaticMarkup(<VerificationPanel d={{...session,source:'demo'}}/>);
    expect(demo).toContain('Open a live session');expect(demo).not.toContain('<form');
    expect(card(criterion,viewer)).not.toContain('Accept behavior');expect(card(criterion,viewer)).not.toContain('Revise');
  });
  it('labels required form fields and disables verification until approved requirements load',()=>{
    const html=renderToStaticMarkup(<VerificationPanel d={session}/>);
    expect(html).toContain('<label>Required behavior<textarea required=""');
    expect(html).toContain('<label>Check command (optional)<input');
    expect(getButton(html,'Run checks and reviewer')).toContain('disabled=""');
    expect(getButton(html,'Save proposal')).toContain('disabled=""');
    const browser=renderToStaticMarkup(<BrowserReviewPanel d={session}/>);
    expect(browser).toContain('Names are self-chosen');expect(browser).toContain('Reviewers cannot run agents or approve commands');
    expect(browser).toContain('Share a screenshot with admitted reviewers<input');
  });
  it('separates successful checks from human acceptance and prevents stale or running reviews',()=>{
    const html=card();expect(html).toContain('Check passed');expect(html).toContain('Accept behavior');expect(html).toContain('Request changes');
    expect(html).toContain('A successful command does not prove complete coverage');
    expect(card(criterion,session,'b'.repeat(64))).not.toContain('Accept behavior');
    expect(card({...criterion,evidence:{...criterion.evidence!,criterionVersion:1}})).not.toContain('Accept behavior');
    expect(card(criterion,{...session,status:'running'})).not.toContain('Accept behavior');
    expect(card(criterion,{...session,status:'running'})).not.toContain('Revise');
    const failed=card({...criterion,status:'failed',evidence:{...criterion.evidence!,exitCode:1,reviews:[{reviewerId:'reviewer',reviewerName:'Tester',reviewerKind:'participant',decision:'accept',comment:null,createdAt:'2030-01-01T00:00:00.000Z'}]}});
    expect(failed).toContain('Check failed');expect(failed).toContain('accepted behavior');expect(failed).not.toContain('Check passed');
  });
  it('renders shared requirement text, model output and reviewer names as text, never HTML',()=>{
    const attack='<img src=x onerror=alert(1)>',html=card({...criterion,text:attack,authorName:attack,evidence:{...criterion.evidence!,output:'<script>alert(1)</script>',reviews:[{reviewerId:'reviewer',reviewerName:attack,reviewerKind:'browser',decision:'reject',comment:attack,createdAt:'2030-01-01T00:00:00.000Z'}]}});
    expect(html).not.toContain('<script>');expect(html).not.toContain('<img src=x');expect(html).toContain('&lt;script&gt;');expect(html).toContain('&lt;img src=x');
  });
});
