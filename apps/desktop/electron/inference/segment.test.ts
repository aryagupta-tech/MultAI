import {describe,expect,it} from 'vitest';
import type {ConnectionSummary} from '../../src/bridge/inference';
import {SAM_MODEL,metaConnection,outputText,parseBoxes,pickBox,pointPrompt,segmentPoint} from './segment';

const png='data:image/png;base64,iVBORw0KGgo=';
const signal=()=>new AbortController().signal;

describe('point at the bug with SAM 3.1',()=>{
  it('writes SAM\'s point prompt in image pixels and refuses points off the image',()=>{
    expect(pointPrompt({x:100,y:200,width:1000,height:800})).toBe('<0f>1<|point;x=100;y=200;w=1000;h=800|>');
    for(const bad of [{x:1000,y:0,width:1000,height:800},{x:-1,y:0,width:10,height:10},{x:1.5,y:0,width:10,height:10},{x:0,y:0,width:0,height:10}])expect(()=>pointPrompt(bad)).toThrow(/isn’t on the screenshot/u);
  });

  it('reads boxes from SAM\'s output, with or without confidence, and skips damaged ones',()=>{
    const lane='<0f>0<|box;x1=181;y1=365;x2=556;y2=486;w=1516;h=1600|><|mask;x=0;y=0;data=122,376,!abc|>,1<|box;x1=10;y1=10;x2=1500;y2=1590;w=1516;h=1600;c=0.91|><|mask;x=0;y=0;c=0.91;data=1,1,!a|>,2<|box;x1=9;y1=9;x2=5|>,3<|box;x1=50;y1=50;x2=40;y2=60;w=1;h=1|>';
    expect(parseBoxes(lane)).toEqual([{x1:181,y1:365,x2:556,y2:486},{x1:10,y1:10,x2:1500,y2:1590}]);
    expect(parseBoxes('')).toEqual([]);
  });

  it('picks the smallest box around the click (the element, not the page), else the nearest',()=>{
    const button={x1:181,y1:365,x2:556,y2:486},page={x1:0,y1:0,x2:1500,y2:1590},icon={x1:2000,y1:2000,x2:2010,y2:2010};
    expect(pickBox([page,button],{x:200,y:400})).toEqual(button);
    expect(pickBox([page,button],{x:1400,y:1500})).toEqual(page);
    expect(pickBox([button,icon],{x:600,y:500})).toEqual(button);
    expect(pickBox([],{x:1,y:1})).toBeNull();
  });

  it('reads the output lane from a JSON response or a stream',()=>{
    expect(outputText(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:'<0f>0<|box;x1=1;y1=2;x2=3;y2=4;w=9;h=9|>'}]}]}),'application/json')).toContain('x1=1');
    expect(outputText(JSON.stringify({output_text:'lane'}),'application/json')).toBe('lane');
    const stream=['data: {"type":"response.output_text.delta","delta":"<0f>0<|box;x1=1;"}','','data: {"type":"response.output_text.delta","delta":"y1=2;x2=3;y2=4;w=9;h=9|>"}','data: [DONE]'].join('\n');
    expect(parseBoxes(outputText(stream,'text/event-stream'))).toEqual([{x1:1,y1:2,x2:3,y2:4}]);
  });

  it('asks sam-3.1 through Meta\'s Responses API and handles refusals and junk input',async()=>{
    let body:Record<string,unknown>|undefined;let url='';
    const fetcher=async(input:string|URL|Request,init?:RequestInit)=>{url=String(input);body=JSON.parse(String(init?.body));return new Response(JSON.stringify({output_text:'<0f>0<|box;x1=10;y1=20;x2=30;y2=40;w=100;h=100|>'}),{headers:{'content-type':'application/json'}});};
    expect(await segmentPoint({apiKey:'meta'},png,{x:15,y:25,width:100,height:100},fetcher as typeof fetch,signal())).toEqual({x1:10,y1:20,x2:30,y2:40});
    expect(url).toBe('https://api.meta.ai/v1/responses');
    expect(body).toMatchObject({model:SAM_MODEL,input:[{role:'user',content:[{type:'input_text',text:'<0f>1<|point;x=15;y=25;w=100;h=100|>'},{type:'input_image',image_url:png}]}]});
    await expect(segmentPoint({apiKey:'m'},'https://example.com/a.png',{x:1,y:1,width:9,height:9},fetcher as typeof fetch,signal())).rejects.toMatchObject({code:'SEGMENT_INVALID'});
    await expect(segmentPoint({apiKey:'m'},png,{x:1,y:1,width:9,height:9},(async()=>new Response('{}',{status:401}))as typeof fetch,signal())).rejects.toMatchObject({code:'provider_credentials_invalid'});
    await expect(segmentPoint({apiKey:'m'},png,{x:1,y:1,width:9,height:9},(async()=>new Response('{}',{status:400}))as typeof fetch,signal())).rejects.toMatchObject({code:'SEGMENT_FAILED'});
    expect(await segmentPoint({apiKey:'m'},png,{x:1,y:1,width:9,height:9},(async()=>new Response(JSON.stringify({output_text:''})))as typeof fetch,signal())).toBeNull();
  });

  it('uses a ready Meta connection, preferring the selected one',()=>{
    const c=(id:string,provider:ConnectionSummary['provider'],status:ConnectionSummary['status']='ready'):ConnectionSummary=>({id,name:id,provider,status,baseUrl:''});
    expect(metaConnection([c('a','openai'),c('b','meta'),c('c','meta')],'c')?.id).toBe('c');
    expect(metaConnection([c('a','openai'),c('b','meta')],'a')?.id).toBe('b');
    expect(metaConnection([c('a','openai'),c('b','meta','sign-in-required')],null)).toBeNull();
  });
});
