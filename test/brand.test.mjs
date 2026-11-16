import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const file=name=>readFileSync(new URL('../public/'+name,import.meta.url));
const signature=Buffer.from([137,80,78,71,13,10,26,10]);
test('brand assets retain the editable mark and correctly sized raster fallbacks',()=>{
 const svg=file('icon.svg').toString();assert.match(svg,/viewBox="0 0 64 64"/);assert.match(svg,/<title[^>]*>Github Observatory/);assert.doesNotMatch(svg,/<script|<foreignObject|\shref=/i);
 for(const size of [32,180]){const bytes=file(`icon-${size}.png`);assert.deepEqual(bytes.subarray(0,8),signature);assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);}
 const ico=file('favicon.ico');assert.equal(ico.readUInt32LE(0),65536);assert.equal(ico.readUInt16LE(4),3);let offset=54;
 for(const [i,size] of [16,32,48].entries()){const entry=6+i*16;assert.equal(ico[entry],size);assert.equal(ico[entry+1],size);assert.equal(ico.readUInt16LE(entry+4),1);assert.equal(ico.readUInt16LE(entry+6),32);const length=ico.readUInt32LE(entry+8);assert.equal(ico.readUInt32LE(entry+12),offset);const png=ico.subarray(offset,offset+length);assert.equal(png.length,length);assert.deepEqual(png.subarray(0,8),signature);assert.equal(png.readUInt32BE(16),size);assert.equal(png.readUInt32BE(20),size);offset+=length;}
 assert.equal(offset,ico.length);
});
