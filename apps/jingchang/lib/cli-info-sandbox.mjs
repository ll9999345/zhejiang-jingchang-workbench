import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {userError} from './workspace.mjs';
const quote=v=>JSON.stringify(v);
export async function offlineCliInfo(executable,args,{cwd,home=os.homedir(),platform=process.platform}={}){
 if(platform!=='darwin')throw userError('项目内即梦帮助目前需要macOS离线隔离；未执行程序',501);
 const work=await fs.realpath(cwd),file=await fs.realpath(executable);await fs.access('/usr/bin/sandbox-exec');
 // Permit only this ordinary executable, the throwaway info directory and OS
 // runtime paths. Do not read the user's CLI auth/log directory, alter HOME,
 // query accounts or let the CLI's startup version check reach a network.
 const aliases=p=>[p,path.join('/System/Volumes/Data',p)],privateRoots=[path.resolve(home),'/Users','/Volumes','/private/var/folders','/var/folders','/private/tmp','/tmp','/private/var/tmp','/var/tmp'];
 const policy=['(version 1)','(allow default)','(deny network*)','(deny mach-lookup)','(deny file-write*)',...privateRoots.flatMap(aliases).map(p=>'(deny file-read* (subpath '+quote(p)+'))'),...aliases(work).map(p=>'(allow file-read* file-write* (subpath '+quote(p)+'))'),...aliases(path.dirname(file)).map(p=>'(allow file-read* (subpath '+quote(p)+'))'),'(allow file-read-metadata)'].join('\n')+'\n';
 const profile=path.join(work,'offline-info.sb');await fs.writeFile(profile,policy,{flag:'wx',mode:0o600});
 return{executable:'/usr/bin/sandbox-exec',arguments:['-f',profile,file,...args],offline:true,profile};
}
