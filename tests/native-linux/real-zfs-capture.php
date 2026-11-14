<?php
// TEST-003 / TEST-006 / PERF-002. Runs as root inside the disposable ZFS VM only.
// Creates its own pool on regular files under $base, records the exact native output of the
// commands the plugin parses, checks the plugin's own parsers on the live system, and times
// the inventory read with 1 000 and 10 000 snapshots. Prints one JSON document.
if(PHP_SAPI!=='cli'||posix_geteuid()!==0)exit(2);
require dirname(__DIR__,2).'/src/backend/ZFSMOperations.php';
$base='/var/lib/zfs-director-real';$pool='zfsmreal';
if(!is_file('/etc/zfsm-disposable-vm'))throw new RuntimeException('Only for the disposable test VM (marker /etc/zfsm-disposable-vm).');
$GLOBALS['plugin_config']=$base.'/director.cfg';$GLOBALS['plugin_state']=$base.'/jobs';$GLOBALS['plugin_runtime']=$base.'/runtime';$GLOBALS['plugin_lock']=$base.'/mutation.lock';$GLOBALS['plugin_audit']=$base.'/audit';
function parse_plugin_cfg($p,$s){return parse_ini_file($GLOBALS['plugin_config'],true,INI_SCANNER_RAW)?:[];}
function sh(string $cmd): string {$out=[];exec($cmd.' 2>&1',$out,$code);if($code!==0)throw new RuntimeException($cmd.': '.implode("\n",$out));return implode("\n",$out);}
function tunable(string $name,string $value): void {file_put_contents('/sys/module/zfs/parameters/'.$name,$value);}
function expect($ok,$message){if(!$ok)throw new RuntimeException($message);}
$fixtures=[];$checks=[];
function diagnostics(string $state): array {
    global $fixtures,$pool;
    $commands=['status'=>['status','-p','-t',$pool],'list'=>['list','-v','-p',$pool]];$raw=[];
    foreach($commands as $name=>$args){$r=runProcess('zpool',$args);$raw[]=['binary'=>'zpool','args'=>$args,'code'=>$r['code'],'output'=>$r['output']];}
    $d=zfsmReadPoolDiagnostics($pool);
    $summary=['health'=>$d['health'],'severity'=>$d['severity'],'scan_state'=>$d['scan']['state']??null,'scan_kind'=>$d['scan']['kind']??null,'reasons'=>$d['reasons']];
    $fixtures[$state]=['commands'=>$raw,'expected'=>$summary];
    return $summary;
}
function check(string $name,callable $fn){global $checks;try{$checks[]=['name'=>$name,'status'=>'PASS','detail'=>$fn()];}catch(Throwable $e){$checks[]=['name'=>$name,'status'=>'FAIL','error'=>$e->getMessage()];}}

// Fresh disposable pool.
if(trim(@shell_exec('zpool list -H -o name '.$pool.' 2>/dev/null')??'')===$pool)sh('zpool destroy -f '.$pool);
sh('rm -rf '.escapeshellarg($base));mkdir($base,0700,true);foreach(['jobs','runtime','audit']as$d)mkdir($base.'/'.$d,0700);
file_put_contents($GLOBALS['plugin_config'],"[general]\nsanoid_integration=\"0\"\ndestructive_mode=\"0\"\nlazy_load=\"0\"\n");touch($GLOBALS['plugin_lock']);
foreach(['a','b'] as $v)sh('truncate -s 1G '.$base.'/vdev-'.$v.'.img');
sh('zpool create -f -o cachefile=none -O mountpoint='.$base.'/mnt '.$pool.' mirror '.$base.'/vdev-a.img '.$base.'/vdev-b.img');
tunable('zfs_scan_suspend_progress','0');

check('a new pool that was never scrubbed is healthy, scan idle',function(){$s=diagnostics('never_scrubbed');expect($s['health']==='ONLINE'&&$s['severity']==='ok','never scrubbed: '.json_encode($s));expect($s['scan_state']==='idle','scan state '.json_encode($s));return $s;});
sh('dd if=/dev/urandom of='.$base.'/mnt/data.bin bs=1M count=200 status=none');sh('zpool sync '.$pool);
check('a running scrub is reported as in progress',function()use($pool){tunable('zfs_scan_suspend_progress','1');sh('zpool scrub '.$pool);usleep(500000);$s=diagnostics('scrub_in_progress');expect($s['scan_kind']==='scrub'&&$s['scan_state']==='running','running scrub: '.json_encode($s));return $s;});
check('a paused scrub is reported as paused',function()use($pool){sh('zpool scrub -p '.$pool);$s=diagnostics('scrub_paused');expect($s['scan_state']==='paused','paused scrub: '.json_encode($s));return $s;});
check('a finished scrub is reported as finished',function()use($pool){tunable('zfs_scan_suspend_progress','0');sh('zpool scrub '.$pool);sh('zpool wait -t scrub '.$pool);$s=diagnostics('scrub_finished');expect($s['scan_state']==='finished'&&$s['severity']==='ok','finished scrub: '.json_encode($s));return $s;});
check('an offline mirror side makes the pool DEGRADED with an error',function()use($pool,$base){sh('zpool offline '.$pool.' '.$base.'/vdev-b.img');$s=diagnostics('degraded');expect($s['health']==='DEGRADED'&&$s['severity']==='error','degraded: '.json_encode($s));return $s;});
check('a resilver is reported as in progress',function()use($pool,$base){sh('dd if=/dev/urandom of='.$base.'/mnt/more.bin bs=1M count=100 status=none');sh('zpool sync '.$pool);tunable('zfs_scan_suspend_progress','1');sh('zpool online '.$pool.' '.$base.'/vdev-b.img');usleep(500000);$s=diagnostics('resilver_in_progress');expect($s['scan_kind']==='resilver','resilver: '.json_encode($s));return $s;});
check('a finished resilver returns the pool to ONLINE',function()use($pool){tunable('zfs_scan_suspend_progress','0');sh('zpool wait -t resilver '.$pool);$s=diagnostics('resilvered');expect($s['health']==='ONLINE','resilvered: '.json_encode($s));return $s;});
check('checksum errors repaired by a scrub are reported',function()use($pool,$base){
    // Overwrite one mirror side except its labels; the other side repairs it during the scrub.
    sh('dd if=/dev/urandom of='.$base.'/vdev-b.img bs=1M seek=4 count=1016 conv=notrunc status=none');
    sh('zpool scrub '.$pool);sh('zpool wait -t scrub '.$pool);$s=diagnostics('scrub_repaired_errors');
    expect($s['severity']==='error'&&preg_grep('/CKSUM errors/',$s['reasons']),'repaired errors: '.json_encode($s));return $s;});
check('cleared errors return the pool to healthy',function()use($pool){sh('zpool clear '.$pool);$s=diagnostics('cleared');expect($s['severity']==='ok','cleared: '.json_encode($s));return $s;});

// Unusual but valid names, a zvol, snapshots and a hold, read through the plugin's inventory.
$names=[$pool.'/My Photos',$pool.'/a.b:c-d_e',$pool.'/a.b:c-d_e/child'];
foreach($names as$n)sh('zfs create '.escapeshellarg($n));
sh('zfs create -V 16M '.$pool.'/vol');
sh('zfs snapshot '.escapeshellarg($pool.'/My Photos@before update'));sh('zfs snapshot -r '.escapeshellarg($pool.'/a.b:c-d_e@s1'));sh('zfs hold keep '.escapeshellarg($pool.'/a.b:c-d_e@s1'));
check('inventory lists unusual dataset and snapshot names exactly',function()use($pool,$names){
    $inv=zfsmReadInventory(loadConfig(parse_plugin_cfg('',true)),true,'');$found=[];
    $walk=function($node)use(&$walk,&$found){$found[$node['name']]=array_map(fn($s)=>$s['name'],$node['snapshots']??[]);foreach($node['child']??[]as$c)$walk($c);};
    $walk($inv['data']['datasets'][$pool]);
    foreach(array_merge($names,[$pool.'/vol'])as$n)expect(array_key_exists($n,$found),'missing '.$n.' in '.json_encode(array_keys($found)));
    expect(in_array($pool.'/My Photos@before update',$found[$pool.'/My Photos'],true),'snapshot with a space: '.json_encode($found[$pool.'/My Photos']));
    expect(($inv['data']['errors']??[])==[],'inventory errors '.json_encode($inv['data']['errors']));
    return ['datasets'=>array_keys($found)];});
check('a held snapshot is listed as a destroy blocker',function()use($pool){
    $scope=zfsmDestroyScope($pool.'/a.b:c-d_e@s1',false);expect(($scope['can_destroy']??true)===false,'held snapshot destroyable: '.json_encode($scope));
    return ['can_destroy'=>$scope['can_destroy'],'dependencies'=>$scope['dependencies']??null];});
sh('zfs release keep '.escapeshellarg($pool.'/a.b:c-d_e@s1'));

// PERF-002: cost of the periodic inventory with many snapshots.
sh('rm -f '.$base.'/mnt/data.bin '.$base.'/mnt/more.bin');sh('zpool sync '.$pool);
// One zfs snapshot call may name each dataset once, so 50 datasets get a snapshot per call.
$perf=[];sh('zfs create '.$pool.'/perf');for($d=0;$d<50;$d++)sh('zfs create '.$pool.'/perf/d'.$d);$made=0;$round=0;
foreach([1000,10000] as $total){
    while($made<$total){$batch=[];for($d=0;$d<50;$d++)$batch[]=escapeshellarg($pool.'/perf/d'.$d.'@s'.str_pad((string)$round,4,'0',STR_PAD_LEFT));sh('zfs snapshot '.implode(' ',$batch));$made+=50;$round++;}
    $cfg=loadConfig(parse_plugin_cfg('',true));$times=['with_snapshots'=>[],'lazy'=>[]];
    for($k=0;$k<3;$k++){$t=microtime(true);zfsmReadInventory($cfg,true,'');$times['with_snapshots'][]=round(microtime(true)-$t,3);$t=microtime(true);zfsmReadInventory($cfg,false,'');$times['lazy'][]=round(microtime(true)-$t,3);}
    $perf[(string)$total]=['median_with_snapshots_s'=>(function($a){sort($a);return $a[1];})($times['with_snapshots']),'median_lazy_s'=>(function($a){sort($a);return $a[1];})($times['lazy']),'runs'=>$times];
}
sh('zpool destroy -f '.$pool);
echo json_encode(['openzfs'=>trim(sh('zfs version | head -1')),'kernel'=>php_uname('r'),'php'=>PHP_VERSION,'checks'=>$checks,'failed'=>count(array_filter($checks,fn($c)=>$c['status']!=='PASS')),'fixtures'=>$fixtures,'perf'=>$perf],JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES)."\n";
