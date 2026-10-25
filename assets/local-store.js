import {CHUNK_SIZE,MAX_APP_BYTES,MAX_FILES,openLocalDB,requestResult,transactionDone,validateUpload,throwIfAborted,mimeFromPath} from './shared.js?v=3';
export class LocalStore {
  constructor(){this.mode='local';this.limits={maxAppBytes:MAX_APP_BYTES,maxFiles:MAX_FILES,chunkSize:CHUNK_SIZE};}
  async connect(){await openLocalDB().then(db=>db.close());return {user:{login:'本地体验',name:'此设备'},repository:{fullName:'此设备 · IndexedDB',private:true,branch:''},limits:this.limits};}
  async listApps(){const db=await openLocalDB();try{const apps=await requestResult(db.transaction('apps').objectStore('apps').getAll());return apps.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}finally{db.close();}}
  async getApp(id){const db=await openLocalDB();try{const app=await requestResult(db.transaction('apps').objectStore('apps').get(id));if(!app)throw new Error('找不到这个本地应用。');return app;}finally{db.close();}}
  async _saveApp(app){const db=await openLocalDB();try{const tx=db.transaction('apps','readwrite');const done=transactionDone(tx);const current=await requestResult(tx.objectStore('apps').get(app.id));if(!current||current.revision!==app.revision){tx.abort();await done.catch(()=>{});throw new Error('应用已经删除或被同名新应用替代。');}tx.objectStore('apps').put(app);await done;return app;}finally{db.close();}}
  async upload(options){
    const input=validateUpload(options);const {signal,onProgress=()=>{}}=options;throwIfAborted(signal);
    let app;
    if(options.resumeId){app=await this.getApp(options.resumeId);if(app.status==='ready')return app;const selected=new Map(input.files.map(item=>[item.path,item]));if(app.entry!==input.entry||app.files.length!==input.files.length||app.files.some(f=>!selected.has(f.path)||selected.get(f.path).file.size!==f.size))throw new Error('续传需要重新选择同一批原始文件，文件路径、大小及入口必须一致。');input.files=app.files.map(file=>selected.get(file.path));}
    else{
      app={schema:1,id:input.slug,slug:input.slug,revision:crypto.randomUUID(),name:input.name,type:input.files.length===1?'html':'app',status:'uploading',entry:input.entry,totalBytes:input.totalBytes,fileCount:input.files.length,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),files:input.files.map(({file,path})=>({path,size:file.size,type:mimeFromPath(path),lastModified:file.lastModified||0,chunks:[]}))};
      const db=await openLocalDB();try{const tx=db.transaction('apps','readwrite');const done=transactionDone(tx);const request=tx.objectStore('apps').add(app);request.onerror=()=>{};try{await done;}catch(error){if(error?.name==='ConstraintError'||request.error?.name==='ConstraintError')throw new Error('这个后缀已经存在，请换一个。');throw error;}}finally{db.close();}
    }
    let loaded=app.files.reduce((sum,f)=>sum+f.chunks.reduce((s,c)=>s+c.size,0),0);const started=performance.now();const initial=loaded;
    const progress=(stage,currentFile='')=>onProgress({stage,loaded,total:app.totalBytes,currentFile,completedFiles:app.files.filter(f=>f.chunks.reduce((s,c)=>s+c.size,0)===f.size).length,totalFiles:app.fileCount,speed:(loaded-initial)/Math.max(.1,(performance.now()-started)/1000),appId:app.id});
    progress('preparing');
    for(let i=0;i<app.files.length;i++){
      const target=app.files[i];const source=input.files[i].file;const count=Math.ceil(source.size/CHUNK_SIZE);
      for(let j=0;j<count;j++){
        throwIfAborted(signal);if(target.chunks[j])continue;
        const blob=source.slice(j*CHUNK_SIZE,Math.min(source.size,(j+1)*CHUNK_SIZE));
        const chunk={key:`${app.id}/${app.revision}/${i}/${j}`,size:blob.size};
        const db=await openLocalDB();try{
          const tx=db.transaction(['apps','chunks'],'readwrite');const done=transactionDone(tx);const apps=tx.objectStore('apps');
          const current=await requestResult(apps.get(app.id));if(!current||current.revision!==app.revision||current.status!=='uploading'){tx.abort();await done.catch(()=>{});throw new Error('应用已经取消或状态发生变化。');}
          target.chunks[j]=chunk;app.updatedAt=new Date().toISOString();
          tx.objectStore('chunks').put({id:chunk.key,appId:app.id,revision:app.revision,fileIndex:i,chunkIndex:j,data:blob,size:blob.size});apps.put(app);await done;
        }catch(error){if(error.name==='QuotaExceededError')throw new Error('此设备的浏览器存储空间不足，请清理应用或连接 GitHub 保存到云端。');throw error;}finally{db.close();}
        loaded+=blob.size;progress('uploading',target.path);await new Promise(resolve=>setTimeout(resolve,0));
      }
      progress('uploading',target.path);
    }
    throwIfAborted(signal);progress('publishing');app.status='ready';app.updatedAt=new Date().toISOString();await this._saveApp(app);progress('complete');return app;
  }
  async renameApp(id,name){name=String(name||'').trim();if(!name||name.length>80)throw new Error('应用名称需要 1–80 个字符。');const app=await this.getApp(id);app.name=name;app.updatedAt=new Date().toISOString();return this._saveApp(app);}
  async deleteApp(id){const db=await openLocalDB();try{const tx=db.transaction(['apps','chunks'],'readwrite');const done=transactionDone(tx);tx.objectStore('apps').delete(id);const index=tx.objectStore('chunks').index('appId');const cursor=index.openKeyCursor(IDBKeyRange.only(id));cursor.onsuccess=()=>{const row=cursor.result;if(row){tx.objectStore('chunks').delete(row.primaryKey);row.continue();}};await done;}finally{db.close();}}
  async streamFile(id,path){const app=await this.getApp(id);const file=app.files.find(f=>f.path===path);if(!file)throw new Error('应用中没有这个文件。');let index=0;const stream=new ReadableStream({async pull(out){try{if(index===file.chunks.length){out.close();return;}const chunk=file.chunks[index++];const db=await openLocalDB();let item;try{item=await requestResult(db.transaction('chunks').objectStore('chunks').get(chunk.key));}finally{db.close();}if(!item||item.revision!==app.revision||item.size!==chunk.size)throw new Error('本地文件分块缺失，请重新上传。');out.enqueue(new Uint8Array(await item.data.arrayBuffer()));}catch(error){out.error(error);}}});return {stream,size:file.size,type:file.type,path};}
  async readFile(id,path){const file=await this.streamFile(id,path);return new Response(file.stream,{headers:{'content-type':file.type}}).blob();}
  async downloadApp(id){const app=await this.getApp(id);const files=[];for(const file of app.files)files.push({path:file.path,blob:await this.readFile(id,file.path)});return files;}
  async sourceFiles(id){
    const app=await this.getApp(id);if(app.status!=='ready')throw new Error('请先完成这个本地应用，再发布到云端。');
    const db=await openLocalDB();
    try{
      const files=[];
      for(const source of app.files){
        const parts=[];
        for(const chunk of source.chunks){const record=await requestResult(db.transaction('chunks').objectStore('chunks').get(chunk.key));if(!record||record.revision!==app.revision||record.data?.size!==chunk.size)throw new Error('本地文件分块缺失，请重新选择原文件发布。');parts.push(record.data);}
        // Blob parts retain their backing storage. Migrating an existing local
        // application never calls arrayBuffer() on an entire large HTML file.
        files.push({path:source.path,file:new File(parts,source.path.split('/').pop(),{type:source.type,lastModified:source.lastModified||Date.now()})});
      }
      return {app,files};
    }finally{db.close();}
  }
}
