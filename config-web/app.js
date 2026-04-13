const DB_UI_VERSION='db-panel-v1';
const DB_KEY='jarvis_active_db_path';
const DEFAULT_DB='/var/www/jarvis/database/jarvis_infra.db';
const els={
 logBox:document.getElementById('logBox'),
 dbStatus:document.getElementById('dbStatus'),
 dbDetails:document.getElementById('dbDetails'),
 selectDb:document.getElementById('selectDb'),
 createDb:document.getElementById('createDb'),
 uploadDb:document.getElementById('uploadDb'),
 exportDb:document.getElementById('exportDb'),
 deleteDb:document.getElementById('deleteDb'),
 closeDbPanel:document.getElementById('closeDbPanel'),
 dbModal:document.getElementById('dbModal'),
 dbModalTitle:document.getElementById('dbModalTitle'),
 dbBrowserPath:document.getElementById('dbBrowserPath'),
 dbBrowserList:document.getElementById('dbBrowserList'),
 dbActionBody:document.getElementById('dbActionBody'),
 dbActionOutput:document.getElementById('dbActionOutput'),
 dbActionConfirm:document.getElementById('dbActionConfirm'),
 dbActionCancel:document.getElementById('dbActionCancel'),
};
const state={activeDb:localStorage.getItem(DB_KEY)||DEFAULT_DB, modalAction:null, selectedPath:null, browserPath:'/var/www/jarvis/database'};

function log(msg,data=null){
 const line=`[DB][${DB_UI_VERSION}] ${msg} ${data?JSON.stringify(data):''}`;
 console.log(line);
 if(els.logBox){els.logBox.textContent=(els.logBox.textContent+'\n'+line).slice(-12000);}
}
function openPanel(name){
 document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
 const panel=document.getElementById('panel-'+name);
 if(panel) panel.classList.add('active');
}
async function api(action,payload={}){
 const res=await fetch('api.php',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,db_path:state.activeDb,...payload})});
 const text=await res.text(); let data={}; try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
 if(!res.ok||data.error) throw new Error(data.error||`HTTP ${res.status}`);
 return data;
}
function renderHealth(data){
 const db=data.db||{};
 const exists=!!db.exists, openOk=!!db.sqlite_open_ok, ok=exists&&openOk;
 const color=ok?'#10b981':exists?'#f59e0b':'#ef4444';
 els.dbStatus.innerHTML=`<div><strong>DB active :</strong> <span style="color:${color}">${db.path||state.activeDb}</span></div>
 <div style="margin-top:.35rem;">${exists?`<a href="api.php?action=download_db&db_path=${encodeURIComponent(db.path)}">Télécharger la DB active</a>`:'<span>Aucune DB active valide.</span>'}</div>`;
 els.dbDetails.textContent=JSON.stringify(data,null,2);
}
async function refreshHealth(){ try{log('health.request',{activeDb:state.activeDb}); const data=await api('healthcheck'); renderHealth(data); log('health.render',data.db||{});}catch(e){els.dbDetails.textContent=String(e.message||e); log('health.error',{error:String(e.message||e)})}}
function openModal(action){
 state.modalAction=action; state.selectedPath=null;
 els.dbModal.hidden=false; els.dbModal.setAttribute('aria-hidden','false'); els.dbModal.style.display='flex';
 els.dbModalTitle.textContent=action==='create'?'Créer une DB':action==='select'?'Sélectionner une DB':action==='delete'?'Effacer une DB':action==='upload'?'Uploader une DB':'Exporter';
 if(action==='create'){els.dbActionBody.innerHTML='<label>Nom du fichier DB</label><input id="modalNewDbName" value="jarvis_infra.db">';}
 else{els.dbActionBody.textContent='Choisis un fichier .db dans l\'arborescence distante puis confirme.';}
 loadBrowser(state.browserPath); log('modal.open',{action});
}
function closeModal(){ els.dbModal.hidden=true; els.dbModal.setAttribute('aria-hidden','true'); els.dbModal.style.display='none'; state.modalAction=null; state.selectedPath=null; log('modal.close',{});}
async function loadBrowser(path){
 try{
  const data=await api('browse_paths',{path});
  state.browserPath=data.current_path;
  els.dbBrowserPath.textContent=data.current_path;
  els.dbBrowserList.innerHTML=(data.items||[]).map(item=>`<button type="button" class="browser-item" data-path="${item.path.replace(/"/g,'&quot;')}" data-type="${item.type}"><span>${item.type==='dir'?'📁':'🗄️'} ${item.name}</span><span>${item.type}</span></button>`).join('')||'Dossier vide.';
  [...els.dbBrowserList.querySelectorAll('[data-path]')].forEach(btn=>btn.onclick=(e)=>{e.preventDefault();const p=btn.dataset.path,t=btn.dataset.type;if(t==='dir'){loadBrowser(p);return;}state.selectedPath=p; [...els.dbBrowserList.querySelectorAll('.browser-item')].forEach(x=>x.classList.remove('selected')); btn.classList.add('selected'); log('browse.select.file',{path:p});});
 }catch(e){els.dbBrowserList.textContent=String(e.message||e); log('browse.error',{error:String(e.message||e)})}
}
async function confirmModalAction(){
 try{
  if(state.modalAction==='create'){
   const name=document.getElementById('modalNewDbName').value.trim(); if(!name) throw new Error('Nom requis');
   const path=`${state.browserPath.replace(/\/+$/,'')}/${name}`;
   const data=await api('create_db',{path});
   state.activeDb=data.path; localStorage.setItem(DB_KEY,state.activeDb); await refreshHealth(); closeModal(); openPanel('dashboard'); return;
  }
  if(state.modalAction==='select'){
   if(!state.selectedPath) throw new Error('Choisis un fichier .db');
   state.activeDb=state.selectedPath; localStorage.setItem(DB_KEY,state.activeDb); await refreshHealth(); closeModal(); openPanel('dashboard'); return;
  }
  if(state.modalAction==='delete'){
   if(!state.selectedPath) throw new Error('Choisis un fichier .db');
   await api('delete_db',{path:state.selectedPath}); if(state.activeDb===state.selectedPath){state.activeDb=DEFAULT_DB; localStorage.setItem(DB_KEY,state.activeDb)} await refreshHealth(); closeModal(); openPanel('dashboard'); return;
  }
  if(state.modalAction==='export'){ window.location=`api.php?action=download_db&db_path=${encodeURIComponent(state.activeDb)}`; closeModal(); return; }
  if(state.modalAction==='upload'){ els.dbActionOutput.textContent='Upload non câblé dans cette version.'; return; }
 }catch(e){els.dbActionOutput.textContent=String(e.message||e); log('action.error',{action:state.modalAction,error:String(e.message||e)})}
}
window.addEventListener('load',()=>{
 document.querySelectorAll('[data-panel]').forEach(btn=>btn.onclick=()=>openPanel(btn.dataset.panel));
 els.closeDbPanel.onclick=()=>openPanel('dashboard');
 els.selectDb.onclick=()=>openModal('select');
 els.createDb.onclick=()=>openModal('create');
 els.uploadDb.onclick=()=>openModal('upload');
 els.exportDb.onclick=()=>openModal('export');
 els.deleteDb.onclick=()=>openModal('delete');
 els.dbActionCancel.onclick=()=>closeModal();
 els.dbActionConfirm.onclick=()=>confirmModalAction();
 els.dbModal.addEventListener('click',e=>{if(e.target===els.dbModal) closeModal();});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!els.dbModal.hidden) closeModal();});
 log('settings.load',{activeDb:state.activeDb});
 refreshHealth();
});
