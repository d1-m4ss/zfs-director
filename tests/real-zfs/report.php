<?php
// TEST-011: assembles the report of one stand run from the result files in $argv[1].
$out=$argv[1]??exit(2);
function sh(string $c): string {$o=[];exec($c.' 2>&1',$o);return trim(implode("\n",$o));}
function load(string $file){return is_file($file)?json_decode((string)file_get_contents($file),true):null;}
$suites=[];$failed=0;
foreach(['capture'=>'capture.json','scenarios'=>'scenarios.json','protection'=>'protection-results.json','protection_ssh'=>'protection-ssh-results.json']as$name=>$file){
    $data=load($out.'/'.$file);
    if($data===null){$suites[$name]=['present'=>false,'passed'=>0,'failed'=>1];$failed++;continue;}
    $checks=$data['checks']??$data['results']??[];$bad=count(array_filter($checks,fn($c)=>($c['status']??'')!=='PASS'));
    $suites[$name]=['present'=>true,'passed'=>count($checks)-$bad,'failed'=>$bad];$failed+=$bad;
}
echo json_encode(['stand'=>'tests/real-zfs/setup.sh','date'=>gmdate('c'),'versions'=>['openzfs'=>sh('zfs version | head -1'),'openzfs_kernel_module'=>sh('zfs version | sed -n 2p'),'sanoid'=>sh('sanoid --version 2>&1 | head -1'),'syncoid'=>sh('syncoid --version 2>&1 | head -1'),'kernel'=>php_uname('r'),'os'=>sh('. /etc/os-release; echo "$PRETTY_NAME"'),'php'=>PHP_VERSION,'rsync'=>sh('rsync --version | head -1'),'openssh'=>sh('ssh -V')],'suites'=>$suites,'failed'=>$failed],JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES)."\n";
exit($failed?1:0);
