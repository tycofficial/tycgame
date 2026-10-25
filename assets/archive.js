import {Unzip,UnzipInflate,Zip,ZipPassThrough} from './vendor/fflate.js?v=3';
import {MAX_APP_BYTES,MAX_FILES,safePath} from './shared.js?v=3';
const DOWNLOAD_LIMIT=512*1024*1024;
function triggerDownload(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
export async function unpackZip(file){
  if(file.size>MAX_APP_BYTES)throw new Error('ZIP 文件超过 2 GiB，请使用文件夹上传。');
  const output=[];let total=0;let failure=null;
  const unzip=new Unzip(entry=>{
    if(failure)return;
    if(entry.name.endsWith('/'))return;
    if(entry.name.startsWith('__MACOSX/')||entry.name.split('/').pop()==='.DS_Store')return;
    let path;try{path=safePath(entry.name);}catch(error){failure=error;return;}
    if(output.length>=MAX_FILES){failure=new Error('ZIP 内文件超过 2000 个。');return;}
    const record={path,file:null};output.push(record);
    {
      const chunks=[];let size=0;
      entry.ondata=(error,data,final)=>{
        if(error){failure=error;return;}
        if(failure)return;
        size+=data.byteLength;total+=data.byteLength;
        if(total>MAX_APP_BYTES){failure=new Error('ZIP 解压后的文件超过 2 GiB。');return;}
        if(data.byteLength)chunks.push(data);
        if(final){record.file=new File(chunks,path.split('/').pop(),{lastModified:file.lastModified});}
      };entry.start();
    }
  });unzip.register(UnzipInflate);
  const reader=file.stream().getReader();
  try{while(true){const {done,value}=await reader.read();if(done)break;unzip.push(value,false);if(failure)throw failure;}unzip.push(new Uint8Array(),true);if(failure)throw failure;if(output.some(item=>!item.file))throw new Error('ZIP 文件不完整。');}
  catch(error){await reader.cancel().catch(()=>{});throw new Error('ZIP 解压失败：'+error.message);}
  if(!output.length)throw new Error('ZIP 内没有可上传的文件。');
  if(new Set(output.map(item=>item.path)).size!==output.length)throw new Error('ZIP 中存在重复文件路径。');
  const paths=output.map(item=>item.path.split('/'));const root=paths[0][0];
  if(paths.every(parts=>parts.length>1&&parts[0]===root))for(const item of output)item.path=item.path.slice(root.length+1);
  return output;
}
export async function downloadApp(store,app){
  // Open the picker while the click still has user activation. Fetching a
  // cloud manifest first can lose that activation on a slow connection.
  const multi=(app.fileCount||app.files?.length||0)>1;
  const pickNow=typeof window.showSaveFilePicker==='function'&&(multi||app.totalBytes>DOWNLOAD_LIMIT);
  const picker=pickNow?window.showSaveFilePicker({suggestedName:multi?app.slug+'.zip':(app.entry||app.slug+'.html').split('/').pop(),...(multi?{types:[{description:'ZIP 应用包',accept:{'application/zip':['.zip']}}]}:{})}):null;
  if(picker)picker.catch(()=>{});
  const full=app.files?app:await store.getApp(app.id);
  if(full.fileCount===1){
    const file=full.files[0];
    if(file.size>DOWNLOAD_LIMIT&&typeof window.showSaveFilePicker==='function'&&store.streamFile){const handle=picker?await picker:await window.showSaveFilePicker({suggestedName:file.path.split('/').pop()});const writable=await handle.createWritable();try{const input=await store.streamFile(full.id,file.path);await input.stream.pipeTo(writable);}catch(error){await writable.abort().catch(()=>{});throw error;}return;}
    if(file.size>DOWNLOAD_LIMIT)throw new Error('此浏览器无法流式保存超大文件，请在桌面 Chrome/Edge 中下载。');
    const list=await store.downloadApp(full.id);const item=list[0];triggerDownload(item.blob,item.path.split('/').pop());return;
  }
  // File System Access lets supported desktop browsers write the ZIP as a stream.
  // Other browsers use a bounded Blob and guide large downloads to the desktop.
  let writable=null;
  if(typeof window.showSaveFilePicker==='function'){
    const handle=picker?await picker:await window.showSaveFilePicker({suggestedName:full.slug+'.zip',types:[{description:'ZIP 应用包',accept:{'application/zip':['.zip']}}]});writable=await handle.createWritable();
  }else if(full.totalBytes>DOWNLOAD_LIMIT)throw new Error('此浏览器无法流式保存超大 ZIP。请在支持文件保存的桌面 Chrome/Edge 中下载，或从 GitHub 数据分支获取文件。');
  const buffers=[];let chain=Promise.resolve();let zipError=null;
  const zip=new Zip((error,data,final)=>{if(error){zipError=error;return;}if(writable)chain=chain.then(()=>writable.write(data));else buffers.push(data);if(final&&writable)chain=chain.then(()=>writable.close());});
  try{
    for(const file of full.files){
      const member=new ZipPassThrough(file.path);zip.add(member);
      // readFile reads only one logical file; files are never collected together.
      let stream;if(store.streamFile)stream=(await store.streamFile(full.id,file.path)).stream;else{const result=await store.readFile(full.id,file.path);const blob=result instanceof Blob?result:result.blob;stream=blob.stream();}
      const reader=stream.getReader();while(true){const {done,value}=await reader.read();if(done)break;member.push(value,false);if(writable)await chain;if(zipError)throw zipError;}member.push(new Uint8Array(),true);
    }
    zip.end();await chain;if(zipError)throw zipError;if(!writable)triggerDownload(new Blob(buffers,{type:'application/zip'}),full.slug+'.zip');
  }catch(error){if(writable)await writable.abort().catch(()=>{});throw error;}
}
