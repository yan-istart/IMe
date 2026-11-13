import {deflateSync,inflateSync} from 'node:zlib';
const crcTable=Uint32Array.from({length:256},(_unused,index)=>{let value=index;for(let bit=0;bit<8;bit++)value=value>>>1^((value&1)?0xedb88320:0);return value>>>0;});
function crc32(bytes:Uint8Array):number {let crc=0xffffffff;for(const byte of bytes)crc=crc>>>8^crcTable[(crc^byte)&255]!;return (crc^0xffffffff)>>>0;}
function chunk(type:string,data:Uint8Array) {
  const header=Buffer.alloc(8),name=Buffer.from(type),checksum=Buffer.alloc(4);header.writeUInt32BE(data.length);name.copy(header,4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([header,data,checksum]);
}
/** Lossless encoding of already redacted grayscale pixels, with no native image dependency. */
export function grayscalePng(width:number,height:number,pixels:Uint8Array) {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>10000000||pixels.length!==width*height)throw Error('INVALID_PNG_DIMENSIONS');
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;
  const scanlines=Buffer.alloc((width+1)*height);for(let y=0;y<height;y++)scanlines.set(pixels.subarray(y*width,(y+1)*width),y*(width+1)+1);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(scanlines)),chunk('IEND',new Uint8Array())]);
}

/** Bounded decoding for non-interlaced 8-bit screenshots. Invalid encodings fail closed. */
export function decodePng(data:Uint8Array):{width:number;height:number;pixels:Uint8Array} {
  const bytes=Buffer.from(data.buffer,data.byteOffset,data.byteLength);
  if(bytes.length<45||bytes.length>40*1024*1024||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('INVALID_PNG');
  let width=0,height=0,color=-1,channels=0,offset=8,ended=false,seenData=false,dataEnded=false;
  let palette:Buffer|undefined,transparency:Buffer|undefined;const compressed:Buffer[]=[];
  while(offset<bytes.length) {
    if(offset+12>bytes.length)throw Error('INVALID_PNG');
    const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8),start=offset+8,end=start+length;
    if(end+4>bytes.length||crc32(bytes.subarray(offset+4,end))!==bytes.readUInt32BE(end))throw Error('INVALID_PNG_CRC');
    const value=bytes.subarray(start,end);offset=end+4;
    if(!width&&type!=='IHDR')throw Error('INVALID_PNG_ORDER');
    if(type==='IHDR') {
      if(width||length!==13)throw Error('INVALID_PNG_HEADER');width=value.readUInt32BE(0);height=value.readUInt32BE(4);color=value[9]!;
      if(!width||!height||width*height>10000000)throw Error('INVALID_PNG_DIMENSIONS');
      if(value[8]!==8||value[10]!==0||value[11]!==0||value[12]!==0||![0,2,3,4,6].includes(color))throw Error('UNSUPPORTED_PNG_FORMAT');
      channels=({0:1,2:3,3:1,4:2,6:4} as Record<number,number>)[color]!;
    } else if(type==='PLTE') {
      if(seenData||palette||!length||length%3||length>768)throw Error('INVALID_PNG_PALETTE');palette=value;
    } else if(type==='tRNS') {
      if(seenData||transparency||![0,2,3].includes(color)||color===0&&length!==2||color===2&&length!==6
        ||color===3&&(!palette||length>palette.length/3))throw Error('INVALID_PNG_TRANSPARENCY');transparency=value;
    } else if(type==='IDAT') {
      if(dataEnded||color===3&&!palette)throw Error('INVALID_PNG_ORDER');seenData=true;compressed.push(value);
    } else if(type==='IEND') {
      if(length||!seenData||offset!==bytes.length)throw Error('INVALID_PNG_END');ended=true;break;
    } else {
      if(type==='acTL'||type==='fcTL'||type==='fdAT')throw Error('UNSUPPORTED_PNG_ANIMATION');
      if(!(bytes[start-4]!&32))throw Error('UNSUPPORTED_PNG_CHUNK');
      if(seenData)dataEnded=true;
    }
  }
  if(!ended)throw Error('INVALID_PNG_END');
  const stride=width*channels,expected=(stride+1)*height;let raw:Buffer;
  try{raw=inflateSync(Buffer.concat(compressed),{maxOutputLength:expected});}catch{throw Error('INVALID_PNG_PIXELS');}
  if(raw.length!==expected)throw Error('INVALID_PNG_PIXELS');
  const reconstructed=new Uint8Array(stride*height),pixels=new Uint8Array(width*height);
  const paeth=(a:number,b:number,c:number)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<height;y++) {
    const filter=raw[y*(stride+1)]!;if(filter>4)throw Error('INVALID_PNG_FILTER');
    for(let x=0;x<stride;x++) {
      const index=y*stride+x,left=x>=channels?reconstructed[index-channels]!:0,up=y?reconstructed[index-stride]!:0,corner=y&&x>=channels?reconstructed[index-stride-channels]!:0;
      const predictor=filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):filter===4?paeth(left,up,corner):0;
      reconstructed[index]=(raw[y*(stride+1)+x+1]!+predictor)&255;
    }
    for(let x=0;x<width;x++) {
      const index=(y*width+x)*channels;let r:number,g:number,b:number,alpha=255;
      if(color===0||color===4){r=g=b=reconstructed[index]!;if(color===4)alpha=reconstructed[index+1]!;else if(transparency&&r===transparency.readUInt16BE())alpha=0;}
      else if(color===3){const entry=reconstructed[index]!;if(entry*3+2>=palette!.length)throw Error('INVALID_PNG_PALETTE_INDEX');r=palette![entry*3]!;g=palette![entry*3+1]!;b=palette![entry*3+2]!;alpha=transparency?.[entry]??255;}
      else{r=reconstructed[index]!;g=reconstructed[index+1]!;b=reconstructed[index+2]!;if(color===6)alpha=reconstructed[index+3]!;
        else if(transparency&&r===transparency.readUInt16BE(0)&&g===transparency.readUInt16BE(2)&&b===transparency.readUInt16BE(4))alpha=0;}
      const gray=Math.round((299*r+587*g+114*b)/1000);pixels[y*width+x]=Math.round((gray*alpha+255*(255-alpha))/255);
    }
  }
  return {width,height,pixels};
}
