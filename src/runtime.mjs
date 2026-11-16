import {mkdir,realpath,chmod,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,dirname,basename,join,relative,isAbsolute} from 'node:path';
const within=(parent,child)=>{const r=relative(parent,child);return !r||(!r.startsWith('..'+ '/')&&r!=='..'&&!isAbsolute(r));};
async function canonicalCandidate(path){try{return await realpath(path);}catch(error){if(error.code!=='ENOENT')throw error;const parent=dirname(path);if(parent===path)throw error;return join(await canonicalCandidate(parent),basename(path));}}
export async function prepareRuntimeDirectory(path,sourceRoot){
 const root=await realpath(sourceRoot),candidate=await canonicalCandidate(resolve(path));
 if(within(root,candidate))throw new Error('Runtime data must be outside the source tree.');
 await mkdir(candidate,{recursive:true,mode:0o700});
 const actual=await realpath(candidate);if(actual!==candidate||within(root,actual))throw new Error('Runtime directory changed unexpectedly.');
 await chmod(actual,0o700);return actual;
}
export async function readSecretFile(path){
 const file=await open(resolve(path),constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const info=await file.stat();if(!info.isFile()||(info.mode&0o077)||info.size>4096)throw new Error('Secret file must be a small regular owner-only file.');const value=(await file.readFile('utf8')).trim();if(!value||value.length>1024)throw new Error('Invalid secret file.');return value;}finally{await file.close();}
}
