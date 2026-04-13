function dblog(msg,data=null){
  console.log("[DB]",msg,data||"");
}

async function api(action){
  const fd=new FormData();
  fd.append("action",action);

  const r=await fetch("api.php",{method:"POST",body:fd});
  return r.json();
}

async function refreshDb(){

  dblog("health.request");

  const res=await api("health");

  dblog("health.response",res);

  const el=document.getElementById("dbStatus");

  if(res.db.exists){
      el.innerHTML=`DB active :
      <a href="api.php?action=download_db">${res.db.path}</a>`;
  }else{
      el.innerHTML="Aucune DB";
  }
}

async function createDb(){
  dblog("create.request");
  const r=await api("create_db");
  dblog("create.response",r);
  refreshDb();
}

async function downloadDb(){
  window.location="api.php?action=download_db";
}

window.addEventListener("load",()=>{
  refreshDb();

  document.getElementById("createDb").onclick=createDb;
  document.getElementById("downloadDb").onclick=downloadDb;
});
