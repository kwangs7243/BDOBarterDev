import {spawn} from 'node:child_process';
import {mkdtemp,readdir,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const tests=dirname(fileURLToPath(import.meta.url)),root=resolve(tests,'../..');
const args=process.argv.slice(2),option=args.indexOf('--out');
if(option>=0&&!args[option+1])throw Error('--out requires a directory');
const output=option>=0?resolve(args[option+1]):await mkdtemp(join(tmpdir(),'bdo-current-regression-'));
await mkdir(output,{recursive:true});
const env={...process.env,PYTHONDONTWRITEBYTECODE:'1',UI_AUDIT_DIR:join(output,'ui'),UI_AUDIT_ALL_VIEWS:'1',BDO_LIVE_REPORT_DIR:join(output,'trade'),BDO_MAP_REPORT_DIR:join(output,'map')};
delete env.BDO_EXTERNAL_APP;delete env.BDO_TEST_URL;delete env.BDO_TEST_PORT;
const domainOnly=args.includes('--domain'),browserOnly=args.includes('--browser');
if(domainOnly&&browserOnly)throw Error('Choose one suite');
const files=(await readdir(tests)).filter(name=>name.endsWith('.mjs')&&name!=='run_current.mjs')
 .filter(name=>domainOnly?!name.startsWith('browser_'):browserOnly?name.startsWith('browser_'):true).sort((a,b)=>Number(a.startsWith('browser_'))-Number(b.startsWith('browser_'))||a.localeCompare(b));
const results=[];
for(const file of files){
 const started=Date.now();let log='';
 const code=await new Promise((done,reject)=>{
  const child=spawn(process.execPath,[join(tests,file)],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>log+=chunk);child.stderr.on('data',chunk=>log+=chunk);
  child.on('error',reject);child.on('exit',code=>done(code));
 });
 await writeFile(join(output,file+'.log'),log);
 results.push({file,status:code===0?'PASS':'FAIL',seconds:(Date.now()-started)/1000});
 console.log(`${code===0?'PASS':'FAIL'} ${file}`);if(code!==0)console.log(log.slice(-2500));
 await writeFile(join(output,'results.json'),JSON.stringify(results,null,2));
}
console.log(JSON.stringify({total:results.length,failed:results.filter(row=>row.status==='FAIL').length,output}));
process.exitCode=results.some(row=>row.status==='FAIL')?1:0;
