// Dependency-free PNG icon generator for the Wizard Trees Field app.
// Draws a white pine tree on a purple gradient. Run: node make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

function crc32(buf){let c=~0;for(let i=0;i<buf.length;i++){c^=buf[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return ~c>>>0;}
function chunk(type,data){
  const t=Buffer.from(type,'ascii');const len=Buffer.alloc(4);len.writeUInt32BE(data.length);
  const body=Buffer.concat([t,data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len,body,crc]);
}
function png(w,h,rgba){
  const sig=Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
  const raw=Buffer.alloc(h*(w*4+1));
  for(let y=0;y<h;y++){raw[y*(w*4+1)]=0;rgba.copy(raw,y*(w*4+1)+1,y*w*4,(y+1)*w*4);}
  return Buffer.concat([sig,chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}
const lerp=(a,b,t)=>Math.round(a+(b-a)*t);

function draw(size, pad){           // pad = fraction of safe padding (maskable)
  const w=size,h=size,buf=Buffer.alloc(w*h*4);
  const set=(x,y,r,g,b)=>{ if(x<0||y<0||x>=w||y>=h)return; const i=(y*w+x)*4; buf[i]=r;buf[i+1]=g;buf[i+2]=b;buf[i+3]=255; };
  // purple gradient background (#7c5cff -> #9d86ff, diagonal)
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const t=(x+y)/(w+h);
    set(x,y,lerp(0x7c,0x9d,t),lerp(0x5c,0x86,t),lerp(0xff,0xff,t));}
  const cx=w/2, inset=size*pad;
  const top=inset+size*0.10, bot=h-inset-size*0.10;
  const trunkW=size*0.07, trunkH=size*0.12;
  // three stacked foliage triangles (white), each overlapping the one below
  const tiers=[[0.46,0.42],[0.38,0.62],[0.30,0.82]]; // [halfWidthFrac, baseYfrac]
  let apex=top;
  for(const [hwF,baseF] of tiers){
    const baseY=top+(bot-top-trunkH)*baseF, hw=size*hwF/2;
    for(let y=Math.floor(apex);y<=baseY;y++){
      const f=(y-apex)/(baseY-apex), cur=hw*f;
      for(let x=Math.round(cx-cur);x<=Math.round(cx+cur);x++) set(x,y,255,255,255);
    }
    apex=top+(bot-top-trunkH)*baseF*0.62;
  }
  // trunk
  for(let y=Math.round(bot-trunkH);y<=Math.round(bot);y++)
    for(let x=Math.round(cx-trunkW/2);x<=Math.round(cx+trunkW/2);x++) set(x,y,255,255,255);
  return png(w,h,buf);
}
writeFileSync(new URL('./icon-192.png',import.meta.url), draw(192,0.06));
writeFileSync(new URL('./icon-512.png',import.meta.url), draw(512,0.06));
writeFileSync(new URL('./icon-maskable-512.png',import.meta.url), draw(512,0.16));
console.log('wrote icon-192.png, icon-512.png, icon-maskable-512.png');
