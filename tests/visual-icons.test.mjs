import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';

function fixture(){const dom=new JSDOM('',{runScripts:'outside-only'});dom.window.eval(readFileSync('src/frontend/ZFSMExplorer.js','utf8'));return dom;}
test('dataset and File Manager icons are inline vectors, decorative and keyboard silent',()=>{
 const dom=fixture();try{
  for(const kind of ['pool','dataset','clone','volume','folder','snapshot','lock','chevron-right','chevron-down','archive','download','restore']){
   const svg=dom.window.zfsmCreateIcon(kind);
   assert.equal(svg.namespaceURI,'http://www.w3.org/2000/svg');assert.equal(svg.getAttribute('viewBox'),'0 0 24 24');
   assert.equal(svg.getAttribute('aria-hidden'),'true');assert.equal(svg.getAttribute('focusable'),'false');assert.equal(svg.dataset.icon,kind);
   assert.ok(svg.querySelector('path[d]'));assert.equal(svg.querySelectorAll('image,use,script,foreignObject').length,0);
  }
 }finally{dom.window.close();}
});
test('File Manager distinguishes common file types without hiding their names or following links',()=>{
 const dom=fixture();try{
  for(const [name,type,expected]of [['photos','directory','folder'],['image.PNG','file','image'],['clip.mkv','file','video'],['track.flac','file','audio'],['backup.sql.gz','file','archive'],['report.pdf','file','pdf'],['settings.json','file','code'],['notes.txt','file','text'],['blob','file','file'],['photo.png','symlink','link'],['photo.png','socket','unavailable']]){
   assert.equal(dom.window.zfsmCreateFileIcon({name,type}).dataset.icon,expected,name);
  }
  const svg=dom.window.zfsmCreateFileIcon({type:'file',name:'photo"><script>bad</script>.png'});
  assert.equal(svg.dataset.icon,'image');assert.equal(svg.textContent,'');assert.equal(svg.querySelector('script'),null);
 }finally{dom.window.close();}
});
