import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';

test('native Unraid right-aligned definition labels do not change Director Overview alignment',()=>{
 const css=readFileSync('src/frontend/ZFSMWorkspace.css','utf8');
 const dom=new JSDOM('<style>dt{text-align:right}</style><style>'+css+'</style><dl><dt id="native-label">Native Unraid</dt></dl><main id="zfsm-workspace"><dl class="zfsm-overview-values"><dt>Name</dt><dd>cache/test</dd></dl></main>');
 try{assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector('#zfsm-workspace dt')).textAlign,'left');assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector('#native-label')).textAlign,'right');}finally{dom.window.close();}
});
