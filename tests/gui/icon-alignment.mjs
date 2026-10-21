import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {startMock,lab} from './mock-server.mjs';

// Render the existing controls. This test uses only synthetic local inventory.
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.ZFSM_PLAYWRIGHT_MODULE||'playwright');
const output=resolve(process.env.ZFSM_OUTPUT||'backups/2026-10-20/icons-existing-fix-fd9d81e');
await mkdir(output,{recursive:true});
const mock=await startMock(),browser=await chromium.launch({executablePath:process.env.ZFSM_CHROME,headless:true});
const measurements=[],failures=[],errors=[],external=[];
const check=(condition,message)=>{if(!condition)failures.push(message);};
async function measure(page,selector){
 return page.locator(selector).evaluateAll(elements=>elements.filter(e=>e.getBoundingClientRect().width>0).map(e=>{
  const box=e.getBoundingClientRect(),parent=e.parentElement,parentBox=parent.getBoundingClientRect(),parentStyle=getComputedStyle(parent),style=getComputedStyle(e),path=e.querySelector('path'),paint=path.getBBox();
  const top=parseFloat(parentStyle.borderTopWidth)+parseFloat(parentStyle.paddingTop),bottom=parseFloat(parentStyle.borderBottomWidth)+parseFloat(parentStyle.paddingBottom);
  const label=parent.querySelector('span:not(.zfsm-operation-icon),.zfsm-node-label'),labelBox=label?.getBoundingClientRect();
  return {name:e.dataset.icon||parent.getAttribute('aria-label')||parent.textContent,width:box.width,height:box.height,flex:style.flex,centerOffset:box.y+box.height/2-parentBox.y-top-(parentBox.height-top-bottom)/2,stroke:parseFloat(style.strokeWidth),cap:style.strokeLinecap,join:style.strokeLinejoin,gap:labelBox?.width?labelBox.x-box.right:null,viewBox:e.getAttribute('viewBox'),paint:{x:paint.x,y:paint.y,width:paint.width,height:paint.height}};
 }));
}
function verify(key,kind,items,size){
 check(items.length>0,key+' missing '+kind+' icons');
 for(const item of items){
  if(size)check(Math.abs(item.width-size)<.1&&Math.abs(item.height-size)<.1,key+' '+kind+' icon must be '+size+' square: '+JSON.stringify(item));
  else check(Math.abs(item.width-item.height)<.1,key+' '+kind+' icon must remain square: '+JSON.stringify(item));
  check(Math.abs(item.centerOffset)<=.6,key+' '+kind+' icon must be centered in its control: '+JSON.stringify(item));
  check(item.viewBox==='0 0 24 24',key+' '+kind+' must retain the common SVG viewBox');
  if(item.gap!==null)check(item.gap>=5,key+' '+kind+' label gap: '+JSON.stringify(item));
 }
}
try{
 for(const width of [390,796,1280])for(const theme of ['auto','dark','gray','light','azure'])for(const layout of ['Workspace','Compact']){
  mock.reset();const context=await browser.newContext({viewport:{width,height:1000},hasTouch:width===390}),page=await context.newPage();
  page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>{if(route.request().url().startsWith(mock.url))return route.continue();external.push(route.request().url());return route.abort();});
  const key=theme+'-'+width+'-'+layout.toLowerCase();
  try{
   await page.goto(mock.url);await page.locator('[data-node="'+lab+'/project"]').click();
   await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption(theme);await page.getByRole('button',{name:layout,exact:true}).click();
   await page.locator('[data-tab=actions]').click();
   const actions=await measure(page,'.zfsm-actions>button>svg'),navigation=await measure(page,'.zfsm-global-nav button>svg,.zfsm-tabs button>svg'),refresh=await measure(page,'.zfsm-refresh-button>svg');
   verify(key,'dataset action',actions,18);verify(key,'navigation',navigation,18);
   verify(key,'header refresh',refresh);for(const item of refresh)check(item.name==='refresh'&&item.width>=16&&item.width<=24,key+' header refresh must use the shared vector refresh icon');
   if(layout==='Workspace')verify(key,'tree',await measure(page,'.zfsm-tree-node>.zfsm-object-icon'),18);
   await page.screenshot({path:output+'/'+key+'-actions.png',fullPage:true});
   await page.locator('[data-tab=snapshots]').click();
   const snapshots=await measure(page,'.zfsm-snapshot-action-button>svg');verify(key,'snapshot action',snapshots,18);
   for(const item of snapshots)check(item.cap==='round'&&item.join==='round',key+' snapshot action must share rounded strokes: '+JSON.stringify(item));
   await page.locator('[data-file-manager]').first().click();await page.getByText('notes.txt',{exact:true}).waitFor();
   const toolbar=await measure(page,'.zfsm-explorer-toolbar .zfsm-action-icon-button>svg'),files=await measure(page,'.zfsm-file-name>svg'),labels=await measure(page,'.zfsm-explorer .zfsm-action-label-button>svg');
   verify(key,'File Manager toolbar',toolbar,20);verify(key,'file',files,17);verify(key,'File Manager labeled action',labels,18);
   for(const item of files.filter(item=>item.name==='link')){
    const p=item.paint,half=item.stroke/2;
    check(p.x-half>=0&&p.y-half>=0&&p.x+p.width+half<=24&&p.y+p.height+half<=24,key+' link strokes must fit the SVG viewBox: '+JSON.stringify(item));
   }
   const overflow=await page.locator('.zfsm-explorer').evaluate(e=>({scroll:e.scrollWidth,client:e.clientWidth}));check(overflow.scroll<=overflow.client+1,key+' File Manager horizontal overflow');
   await page.screenshot({path:output+'/'+key+'-files.png',fullPage:false});
   measurements.push({key,actions,navigation,refresh,snapshots,toolbar,files,labels,overflow});
  }catch(error){failures.push(key+': '+error.message);}finally{await context.close();}
 }
 assert.deepEqual(errors,[],'No browser errors');assert.deepEqual(external,[],'No external requests');
 const report={status:failures.length?'FAIL':'PASS',cases:measurements.length,failures,errors,external,measurements};
 await writeFile(output+'/measurements.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({status:report.status,cases:report.cases,failures:failures.length,output},null,2));
 assert.equal(failures.length,0,'Existing icon geometry and strokes must align: '+failures.slice(0,3).join('\n'));
}finally{await browser.close();await mock.close();}
