<?php
header('Content-Type: application/json');

function logdb($msg,$data=null){
    error_log("[DB] ".$msg." ".json_encode($data));
}

function respond($data){
    echo json_encode($data,JSON_PRETTY_PRINT);
    exit;
}

function db_path(){
    return getenv('JARVIS_INFRA_DB') ?: __DIR__.'/jarvis_infra.db';
}

function db_exists(){
    return file_exists(db_path());
}

function db_health(){
    $path=db_path();
    return [
        "path"=>$path,
        "exists"=>file_exists($path),
        "readable"=>is_readable($path),
        "writable"=>is_writable(dirname($path))
    ];
}

function create_db(){
    $path=db_path();
    logdb("create.request",$path);

    if(file_exists($path)){
        respond(["ok"=>true,"message"=>"db already exists"]);
    }

    try{
        $pdo=new PDO("sqlite:$path");
        $pdo->exec("CREATE TABLE IF NOT EXISTS sensitive_values(
            namespace TEXT,
            key TEXT,
            value TEXT
        )");
        logdb("create.done",$path);
        respond(["ok"=>true,"path"=>$path]);
    }catch(Exception $e){
        respond(["error"=>$e->getMessage()]);
    }
}

function download_db(){
    $path=db_path();
    logdb("download.request",$path);

    if(!file_exists($path)){
        respond(["error"=>"db not found"]);
    }

    header('Content-Type: application/octet-stream');
    header('Content-Disposition: attachment; filename="jarvis_infra.db"');
    readfile($path);
    exit;
}

$action=$_POST['action'] ?? $_GET['action'] ?? 'health';

switch($action){

case "health":
    respond(["db"=>db_health()]);

case "create_db":
    create_db();
    break;

case "download_db":
    download_db();
    break;

default:
    respond(["error"=>"unknown action"]);
}
