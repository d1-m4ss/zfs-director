<?php
require '/app/harness.php';
$GLOBALS['plugin_config']='/config/director.cfg';$GLOBALS['plugin_runtime']='/runtime';
function parse_plugin_cfg($p,$s){return [];}
function mustReject($fn){try{$fn();}catch(InvalidArgumentException|RuntimeException$e){return;}throw new LogicException('Expected rejection');}
check('templates and recursive inheritance retain child overrides',function(){
 $c=zfsmSanoidParse("[template_prod]\nhourly=24\ndaily=7\nautosnap=yes\nautoprune=yes\n[cache/data]\nuse_template=prod\nrecursive=yes\n[cache/data/child]\nhourly=2\n");
 same('2',zfsmSanoidEffective($c,'cache/data/child')['hourly']);same('7',zfsmSanoidEffective($c,'cache/data/child')['daily']);
 same('2',zfsmSanoidEffective($c,'cache/data/child/grandchild')['hourly']);
});
check('children-only and exclusions do not snapshot excluded objects',function(){
 $p=zfsmSanoidPolicy(['dataset'=>'cache/data','recursive'=>'1','process_children_only'=>'1','exclusions'=>['cache/data/private'],'hourly'=>'3']);
 same(['cache/data/child'],zfsmSanoidScope($p,['cache/data','cache/data/child','cache/data/private','cache/data/private/x']));
});
check('all six retention tiers validate without coercion or shell input',function(){
 foreach(['frequently','hourly','daily','weekly','monthly','yearly']as$t){same(3,zfsmSanoidPolicy(['dataset'=>'cache/data',$t=>'3'])[$t]);mustReject(fn()=>zfsmSanoidPolicy(['dataset'=>'cache/data',$t=>'3; touch /x']));}
 mustReject(fn()=>zfsmSanoidPolicy(['dataset'=>'cache/data','recursive'=>'nope']));mustReject(fn()=>zfsmSanoidPolicy(['dataset'=>'cache/data','unknown_hook'=>'/bin/evil']));
});
check('duplicate sections hooks and unsupported syntax do not become managed executable config',function(){
 mustReject(fn()=>zfsmSanoidParse("[cache/a]\nhourly=1\n[cache/a]\nhourly=2"));
 $p=zfsmSanoidPolicy(['dataset'=>'cache/data','autosnap'=>'1','autoprune'=>'1','use_template'=>'production']);$text=zfsmSanoidConfig([$p],['production'=>['hourly'=>'24']]);same(true,str_contains($text,'[template_production]'));same(true,str_contains($text,'autoprune = no'));same(false,str_contains($text,'pre_snapshot_script'));
});
check('scope conflicts include parent child external policies and exact boundaries',function(){
 same(true,zfsmProtectionScopeOverlap('cache/a','cache/a/child'));same(false,zfsmProtectionScopeOverlap('cache/a','cache/ab'));
 mustReject(fn()=>zfsmSanoidPolicyConflicts(['dataset'=>'cache/a','recursive'=>true], [['dataset'=>'cache/a/child','owner'=>'external']]));
});
check('retention never adopts a manual snapshot by matching its name',function(){
 $a='cache/a@autosnap_2026-10-01_00:00:00_hourly';$b='cache/a@autosnap_2026-10-02_00:00:00_hourly';
 $plan=zfsmSanoidRetentionPlan("INFO: pruning $a ... \nINFO: pruning $b ...",[$a=>['guid'=>'12','dataset_guid'=>'100'],$b=>['guid'=>'13','dataset_guid'=>'100']],[$b=>['guid'=>'13','dataset_guid'=>'100','policy_id'=>'abc']],[],'abc');
 same([$b],array_column($plan['candidates'],'name'));same([$a],array_column($plan['protected'],'name'));
});
check('changed GUID held and replication base snapshots are preserved',function(){
 $n='cache/a@autosnap_x_hourly';$inv=[$n=>['guid'=>'12','dataset_guid'=>'100','holds'=>true]];$own=[$n=>['guid'=>'11','dataset_guid'=>'100','policy_id'=>'abc']];
 same([],zfsmSanoidRetentionPlan("INFO: pruning $n ...",$inv,$own,[],'abc')['candidates']);$own[$n]['guid']='12';same([],zfsmSanoidRetentionPlan("INFO: pruning $n ...",$inv,$own,[$n],'abc')['candidates']);
});
check('configuration store atomic writes keep backups and reject unsupported schema',function(){
 $s=zfsmProtectionReadStore();same(1,$s['version']);$s['policies']['abc']=['dataset'=>'cache/a'];zfsmProtectionWriteStore($s);same('cache/a',zfsmProtectionReadStore()['policies']['abc']['dataset']);
 $s['policies']=[];zfsmProtectionWriteStore($s);same(true,is_file(zfsmProtectionDirectory().'/config.json.bak'));file_put_contents(zfsmProtectionDirectory().'/config.json','{"version":99}');mustReject(fn()=>zfsmProtectionReadStore());unlink(zfsmProtectionDirectory().'/config.json');
});
check('signed previews reject changed input expired data wrong secret and changed configuration',function(){
 $p=zfsmProtectionPreview(['type'=>'policy','value'=>['dataset'=>'cache/a']],'secret','fingerprint');same('cache/a',zfsmProtectionConsumePreview($p,'secret','fingerprint')['value']['dataset']);
 mustReject(fn()=>zfsmProtectionConsumePreview($p,'secret','fingerprint'));
 $p=zfsmProtectionPreview(['type'=>'policy','value'=>[]],'secret','a');mustReject(fn()=>zfsmProtectionConsumePreview($p,'bad','a'));mustReject(fn()=>zfsmProtectionConsumePreview($p,'secret','b'));
 $file=$GLOBALS['plugin_runtime'].'/protection-previews/'.$p['preview_id'].'.json';$record=json_decode(file_get_contents($file),true);$record['expires']=time()-1;file_put_contents($file,json_encode($record));$p['token']=hash_hmac('sha256',$p['preview_id'].json_encode($record,JSON_THROW_ON_ERROR),'secret');mustReject(fn()=>zfsmProtectionConsumePreview($p,'secret','a'));
});
check('snapshot provenance requires a native creation report and a new matching GUID',function(){
 $n='cache/a@autosnap_x_hourly';$before=['snapshots'=>[]];$after=['snapshots'=>[$n=>['guid'=>'12','dataset_guid'=>'100']]];
 same([$n=>['guid'=>'12','dataset_guid'=>'100','policy_id'=>'abc']],zfsmSanoidCreated("taking snapshot $n\n",$before,$after,'abc'));
 same([],zfsmSanoidCreated('',$before,$after,'abc'));same([],zfsmSanoidCreated("taking snapshot $n\n",$after,$after,'abc'));
});
check('reviewed external transfer preserves unrelated bytes and refuses script hooks',function(){
 $text="# retained\n[cache/a]\nhourly=3\nautosnap=yes\n\n[cache/b]\nhourly=9\n";
 $r=zfsmSanoidDetachExternal($text,'cache/a');same("# retained\n[cache/b]\nhourly=9\n",$r['after']);same(true,str_contains($r['removed'],'hourly=3'));
 mustReject(fn()=>zfsmSanoidDetachExternal("[cache/a]\npre_snapshot_script=/root/custom\n",'cache/a'));
 mustReject(fn()=>zfsmSanoidDetachExternal("[cache]\nrecursive=yes\n[cache/a]\nhourly=3\n",'cache/a'));
});
check('distribution defaults are discovered at their real trusted package path',function(){
 @mkdir('/usr/share/sanoid',0755,true);file_put_contents('/usr/share/sanoid/sanoid.defaults.conf',"[template_default]\nhourly=24\n");chmod('/usr/share/sanoid/sanoid.defaults.conf',0644);same('/usr/share/sanoid/sanoid.defaults.conf',zfsmSanoidDefaultsFile());
});
check('preview and execution configuration is immutable per invocation with a shared policy native lock',function(){
 $p=zfsmSanoidPolicy(['id'=>'ace','dataset'=>'cache/a']);$first=zfsmSanoidPrepare($p,['cache/a']);$dir=substr($first[0],strlen('--configdir='));$original=file_get_contents($dir.'/sanoid.conf');
 $p['dataset']='cache/b';$second=zfsmSanoidPrepare($p,['cache/b'],true);same(false,$first[0]===$second[0]);same($original,file_get_contents($dir.'/sanoid.conf'));same(true,str_contains(file_get_contents(substr($second[0],strlen('--configdir=')).'/sanoid.conf'),'[cache/b]'));
 same($first[2],$second[2]);same(false,$first[1]===$second[1]);
});
finishTests();
