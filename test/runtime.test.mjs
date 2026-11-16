import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,stat,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareRuntimeDirectory,readSecretFile} from '../src/runtime.mjs';
test('runtime rejects source paths and symlink aliases before mutating permissions',async t=>{
 const base=await mkdtemp(join(tmpdir(),'observatory-runtime-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const root=join(base,'source');await mkdir(root,{mode:0o755});const original=(await stat(root)).mode;
 await assert.rejects(prepareRuntimeDirectory(root,root));assert.equal((await stat(root)).mode,original);
 await symlink(root,join(base,'alias'));
 await assert.rejects(prepareRuntimeDirectory(join(base,'alias','new-state'),root));
 await assert.rejects(stat(join(root,'new-state')));
 const dest=await prepareRuntimeDirectory(join(base,'private','state'),root);assert.equal((await stat(dest)).mode&0o777,0o700);
});
test('invalid proxy startup fails before creating runtime state or writer lock',async t=>{
 const base=await mkdtemp(join(tmpdir(),'observatory-startup-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const key=join(base,'key');await writeFile(key,'synthetic-proxy-secret-with-more-than-32-characters',{mode:0o600});
 const state=join(base,'state'),env={...process.env,OBSERVATORY_DATA_DIR:state,OBSERVATORY_BIND_HOST:'0.0.0.0',OBSERVATORY_PUBLIC_ORIGIN:'http://invalid.example',OBSERVATORY_PROXY_KEY_FILE:key};delete env.GITHUB_TOKEN_FILE;
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../src/main.mjs',import.meta.url))],{env,encoding:'utf8',timeout:10000});
 assert.equal(result.status,1);assert.match(result.stderr,/HTTPS origin/);await assert.rejects(stat(state));
});

test('secret files must be regular owner-only files; symlinks refused',async t=>{
 const base=await mkdtemp(join(tmpdir(),'observatory-secrets-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const file=join(base,'secret');await writeFile(file,'synthetic-secret\n',{mode:0o600});assert.equal(await readSecretFile(file),'synthetic-secret');
 await symlink(file,join(base,'alias'));await assert.rejects(readSecretFile(join(base,'alias')));
 await writeFile(join(base,'public'),'bad',{mode:0o644});await assert.rejects(readSecretFile(join(base,'public')));
});
