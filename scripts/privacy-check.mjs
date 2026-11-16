import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const ignored=new Set(['.git','node_modules','coverage','test-results','playwright-report']);
const patterns=[
 ['GitHub credential',/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/],
 ['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['cloud key',/\bAKIA[0-9A-Z]{16}\b/],
 ['personal host path',/\/(?:Users|home)\/[a-zA-Z][^\s/'"<>]*/],
 ['private LAN address',/\b192\.168\.\d{1,3}\.\d{1,3}\b/]
];
// Only reviewed, reproducibly synthetic publication images belong in source.
const demoImages=new Set(['docs/screenshots/dashboard.png','docs/screenshots/issues-modal.png','docs/screenshots/mobile.png']);
const brandImages=new Map([['public/icon-32.png',32],['public/icon-180.png',180]]);
const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
const failures=[];let checked=0;
function walk(dir){for(const name of readdirSync(dir)){if(ignored.has(name))continue;const path=join(dir,name),stat=lstatSync(path),rel=relative(root,path);if(stat.isSymbolicLink()){failures.push([rel,'symlink']);continue;}if(stat.isDirectory()){if(['data','state','private','backups','screenshots'].includes(name)&&rel!=='docs/screenshots')failures.push([rel,'runtime/artifact directory']);else walk(path);continue;}
 if(demoImages.has(rel)){const bytes=readFileSync(path);checked++;if(stat.size>2*1024*1024||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))failures.push([rel,'invalid demo PNG']);continue;}
 if(brandImages.has(rel)){const bytes=readFileSync(path),size=brandImages.get(rel);checked++;if(bytes.length<24||bytes.length>128*1024||!bytes.subarray(0,8).equals(pngSignature)||bytes.readUInt32BE(16)!==size||bytes.readUInt32BE(20)!==size)failures.push([rel,'invalid generated brand PNG']);continue;}
 if(rel==='public/favicon.ico'){const bytes=readFileSync(path);checked++;let valid=bytes.length>=54&&bytes.length<128*1024&&bytes.readUInt32LE(0)===65536&&bytes.readUInt16LE(4)===3,offset=54;
  if(valid)for(const [i,size] of [16,32,48].entries()){const entry=6+i*16,length=bytes.readUInt32LE(entry+8),start=bytes.readUInt32LE(entry+12);if(bytes[entry]!==size||bytes[entry+1]!==size||start!==offset||length<24||start+length>bytes.length||!bytes.subarray(start,start+8).equals(pngSignature)){valid=false;break;}offset+=length;}
  if(!valid||offset!==bytes.length)failures.push([rel,'invalid generated favicon']);continue;
 }
 if(/\.(?:db|sqlite|log|pem|key|token|png|jpg|ico|zip)(?:[-.]|$)/i.test(name)||(/^\.env/.test(name)&&name!=='.env.example')){failures.push([rel,'private/artifact file']);continue;}
 if(stat.size>2*1024*1024){failures.push([rel,'unexpected large file']);continue;}
 const text=readFileSync(path,'utf8');checked++;
 for(const [label,regex] of patterns)if(regex.test(text))failures.push([rel,label]);
}}
walk(root);
if(failures.length){for(const [path,label] of failures)console.error(`${path}: ${label} (value withheld)`);process.exitCode=1;}else console.log(`Privacy preflight passed for ${checked} source files. Runtime state, real screenshots and credentials must stay outside this tree. Allowlisted demo images require synthetic-generator and human review.`);
