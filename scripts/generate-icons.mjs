// Rebuild raster fallbacks from the single editable SVG; no network access.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../',import.meta.url));
const source=await readFile(resolve(root,'public/icon.svg'),'utf8');
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
try{
 const page=await browser.newPage();await page.route('**/*',route=>route.abort());
 const render=async size=>Buffer.from(await page.evaluate(async({source,size})=>{
  const image=new Image();image.src='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(source)));await image.decode();
  const canvas=document.createElement('canvas');canvas.width=canvas.height=size;canvas.getContext('2d').drawImage(image,0,0,size,size);return canvas.toDataURL('image/png').split(',')[1];
 },{source,size}),'base64');
 for(const size of [32,180])await writeFile(resolve(root,`public/icon-${size}.png`),await render(size));
 const sizes=[16,32,48],images=await Promise.all(sizes.map(render)),header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);
 let offset=header.length;images.forEach((image,i)=>{const entry=6+i*16;header[entry]=header[entry+1]=sizes[i];header.writeUInt16LE(1,entry+4);header.writeUInt16LE(32,entry+6);header.writeUInt32LE(image.length,entry+8);header.writeUInt32LE(offset,entry+12);offset+=image.length;});
 await writeFile(resolve(root,'public/favicon.ico'),Buffer.concat([header,...images]));
 if(process.env.ICON_PREVIEW_PATH)await writeFile(resolve(process.env.ICON_PREVIEW_PATH),await render(512));
 console.log('Generated 32px/180px PNGs and 16px/32px/48px ICO from icon.svg; external requests blocked.');
}finally{await browser.close();}
