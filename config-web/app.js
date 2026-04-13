let state = {
    services:[],
    current:null
}

async function api(action,data={}){

    const r = await fetch("api.php",{
        method:"POST",
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action,...data})
    })

    return await r.json()
}

async function loadServices(){

    const data = await api("list_services")

    state.services = data.services || []

    const el = document.getElementById("serviceList")

    el.innerHTML=""

    state.services.forEach(s=>{

        const b=document.createElement("button")

        b.textContent=s.name

        b.onclick=()=>selectService(s)

        el.appendChild(b)
    })
}

function selectService(s){

    state.current=s

    document.getElementById("serviceTitle").textContent=s.name

    showConfig()
}

function showConfig(){

    const v=document.getElementById("view")

    if(!state.current)return

    const req=state.current.config_requirements||[]

    let html="<h3>Configuration</h3>"

    req.forEach(r=>{

        html+=`
        <div>
        <label>${r.label}</label>
        <input id="cfg_${r.key}" placeholder="${r.key}">
        </div>
        `
    })

    html+=`<button onclick="saveConfig()">Sauver</button>`

    v.innerHTML=html
}

async function saveConfig(){

    const req=state.current.config_requirements||[]

    let data={}

    req.forEach(r=>{

        data[r.key]=document.getElementById("cfg_"+r.key).value
    })

    await api("save_service_config",{
        service:state.current.name,
        config:data
    })

    alert("Config sauvée")
}

function showTest(){

    const v=document.getElementById("view")

    v.innerHTML=`
    <h3>Test service</h3>
    <textarea id="jsonInput" style="width:100%;height:200px">{}</textarea>
    <br><br>
    <button onclick="runTest()">Exécuter</button>
    <pre id="testResult"></pre>
    `
}

async function runTest(){

    const input=document.getElementById("jsonInput").value

    const r=await api("run_service_test",{
        service:state.current.name,
        payload:JSON.parse(input)
    })

    document.getElementById("testResult").textContent=JSON.stringify(r,null,2)
}

function showCode(){

    const v=document.getElementById("view")

    v.innerHTML='<div id="editor"></div>'

    require.config({ paths: { 'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs' }});

    require(['vs/editor/editor.main'], function () {

        window.editor = monaco.editor.create(document.getElementById('editor'), {
            value: "# charger fichier ici",
            language: 'python',
            theme:'vs-dark'
        });

    });
}

async function showRuns(){

    const v=document.getElementById("view")

    const r=await api("list_runs",{service:state.current.name})

    let html="<h3>Historique</h3>"

    r.runs.forEach(run=>{

        html+=`<div>${run.started_at} - ${run.status}</div>`
    })

    v.innerHTML=html
}

loadServices()
