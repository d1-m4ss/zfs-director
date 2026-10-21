<?php
require '/app/harness.php';
require_once '/app/src/backend/ZFSMOperations.php';
check('explicit native clocks reach dataset config without enabling native pruning',function(){
    $input=['dataset'=>'cache/test','hourly_min'=>'0','daily_hour'=>'3','daily_min'=>'0','weekly_wday'=>'0','weekly_hour'=>4,'weekly_min'=>15,'monthly_mday'=>28,'monthly_hour'=>5,'monthly_min'=>30,'yearly_mon'=>2,'yearly_mday'=>28,'yearly_hour'=>6,'yearly_min'=>45,'frequent_period'=>15,'autoprune'=>true];
    $p=zfsmSanoidPolicy($input);$c=zfsmSanoidParse(zfsmSanoidConfig([$p]))['cache/test'];
    foreach(zfsmSanoidTimingFields()as$key=>$range)same((string)$input[$key],$c[$key]);same('no',$c['autoprune']);
});
check('old policies and blank timing retain inheritance without injecting overrides',function(){
    $p=zfsmSanoidPolicy(['dataset'=>'cache/test','daily_hour'=>'','daily_min'=>null]);$c=zfsmSanoidParse(zfsmSanoidConfig([$p]))['cache/test'];
    foreach(zfsmSanoidTimingFields()as$key=>$range)same(false,array_key_exists($key,$c));
});
check('timing refuses invalid types and bounds, accepts every boundary',function(){
    foreach(zfsmSanoidTimingFields()as$key=>[$min,$max]){foreach([$min,$max]as$v)same($v,zfsmSanoidPolicy(['dataset'=>'cache/test',$key=>$v])[$key]);foreach([$min-1,$max+1,true,[],1.5,'1; touch /bad']as$v){$rejected=false;try{zfsmSanoidPolicy(['dataset'=>'cache/test',$key=>$v]);}catch(InvalidArgumentException$e){$rejected=true;}same(true,$rejected);}}
});
check('safe templates preserve timing with default then named then policy precedence',function(){
    $templates=['default'=>['daily_hour'=>'21','daily_min'=>'5'],'first'=>['daily_hour'=>'2','hourly_min'=>'10'],'second'=>['daily_hour'=>'4','hourly_min'=>'20','post_snapshot_script'=>'/bad']];
    $p=zfsmSanoidPolicy(['dataset'=>'cache/test','use_template'=>'first,second','daily_min'=>0]);
    $c=zfsmSanoidParse(zfsmSanoidConfig([$p],$templates));same('4',$c['template_second']['daily_hour']);same(false,isset($c['template_second']['post_snapshot_script']));
    $v=zfsmSanoidSnapshotEffective($p,$templates,['daily_hour'=>23,'daily_min'=>59,'hourly_min'=>0]);same(4,$v['daily_hour']);same(0,$v['daily_min']);same(20,$v['hourly_min']);
});
check('installed defaults are read from trusted configuration and missing values remain unknown',function(){
    @mkdir('/etc/sanoid',0755,true);file_put_contents('/etc/sanoid/sanoid.defaults.conf',"[template_default]\ndaily_hour = 22\ndaily_min = 17\nhourly = 24\npost_snapshot_script = /private\n");chmod('/etc/sanoid/sanoid.defaults.conf',0644);
    $v=zfsmSanoidSnapshotDefaults();same(22,$v['daily_hour']);same(17,$v['daily_min']);same(24,$v['hourly']);same(false,isset($v['weekly_hour']));same(false,isset($v['post_snapshot_script']));
});
check('active calendar dates must be valid every month or every year',function(){
    foreach([['monthly'=>3,'monthly_mday'=>31],['yearly'=>2,'yearly_mon'=>2,'yearly_mday'=>29],['yearly'=>2,'yearly_mon'=>4,'yearly_mday'=>31]]as$values){$rejected=false;try{zfsmSanoidValidateSnapshotCalendar($values);}catch(InvalidArgumentException$e){$rejected=true;}same(true,$rejected);}
    zfsmSanoidValidateSnapshotCalendar(['monthly'=>0,'monthly_mday'=>31]);zfsmSanoidValidateSnapshotCalendar(['yearly'=>2,'yearly_mon'=>12,'yearly_mday'=>31]);
});
check('external snapshot times resolve default templates inside their own source file',function(){
    $GLOBALS['plugin_config']='/state/settings.cfg';@mkdir('/state',0700,true);@mkdir('/boot/config/plugins/unRAID6-Sanoid',0755,true);
    file_put_contents('/etc/sanoid/sanoid.conf',"[template_default]\ndaily_hour=3\ndaily_min=10\n[cache/a]\ndaily=7\n");
    file_put_contents('/boot/config/plugins/unRAID6-Sanoid/sanoid.conf',"[template_default]\ndaily_hour=22\ndaily_min=50\n[cache/b]\ndaily=7\n");
    $data=zfsmSanoidRead();same([],$data['issues']);$rows=array_column($data['policies'],null,'dataset');same(3,$rows['cache/a']['snapshot_effective']['daily_hour']);same(10,$rows['cache/a']['snapshot_effective']['daily_min']);same(22,$rows['cache/b']['snapshot_effective']['daily_hour']);same(50,$rows['cache/b']['snapshot_effective']['daily_min']);
});
finishTests();
