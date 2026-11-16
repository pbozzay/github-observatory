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
const failures=[];let checked=0;
function walk(dir){for(const name of readdirSync(dir)){if(ignored.has(name))continue;const path=join(dir,name),stat=lstatSync(path),rel=relative(root,path);if(stat.isSymbolicLink()){failures.push([rel,'symlink']);continue;}if(stat.isDirectory()){if(['data','state','private','backups','screenshots'].includes(name))failures.push([rel,'runtime/artifact directory']);else walk(path);continue;}
 if(/\.(?:db|sqlite|log|pem|key|token|png|jpg|zip)(?:[-.]|$)/i.test(name)||(/^\.env/.test(name)&&name!=='.env.example')){failures.push([rel,'private/artifact file']);continue;}
 if(stat.size>2*1024*1024){failures.push([rel,'unexpected large file']);continue;}
 const text=readFileSync(path,'utf8');checked++;
 for(const [label,regex] of patterns)if(regex.test(text))failures.push([rel,label]);
}}
walk(root);
if(failures.length){for(const [path,label] of failures)console.error(`${path}: ${label} (value withheld)`);process.exitCode=1;}else console.log(`Privacy preflight passed for ${checked} source files. Runtime state, screenshots and credentials must stay outside this tree.`);
