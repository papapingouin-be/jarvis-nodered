<?php
header('Content-Type: application/json');

$payload=json_decode(file_get_contents("php://input"),true);
$action=$payload['action']??"";

$db=new PDO("sqlite:devlab.db");
$db->setAttribute(PDO::ATTR_ERRMODE,PDO::ERRMODE_EXCEPTION);

$db->exec("CREATE TABLE IF NOT EXISTS devlab_runs(
id INTEGER PRIMARY KEY AUTOINCREMENT,
service TEXT,
status TEXT,
started_at TEXT,
payload TEXT,
output TEXT
)");

if($action=="list_services"){

    echo json_encode([
        "services"=>[
            [
                "name"=>"example_service",
                "config_requirements"=>[
                    ["key"=>"API_URL","label"=>"API URL"],
                    ["key"=>"TOKEN","label"=>"Token"]
                ]
            ]
        ]
    ]);
    exit;
}

if($action=="save_service_config"){

    echo json_encode(["ok"=>true]);
    exit;
}

if($action=="run_service_test"){

    $stmt=$db->prepare("INSERT INTO devlab_runs(service,status,started_at,payload,output)
    VALUES(:s,'ok',datetime('now'),:p,:o)");

    $stmt->execute([
        ":s"=>$payload['service'],
        ":p"=>json_encode($payload['payload']),
        ":o"=>json_encode(["result"=>"demo"])
    ]);

    echo json_encode(["result"=>"demo run"]);
    exit;
}

if($action=="list_runs"){

    $stmt=$db->query("SELECT * FROM devlab_runs ORDER BY id DESC LIMIT 20");

    echo json_encode(["runs"=>$stmt->fetchAll(PDO::FETCH_ASSOC)]);
    exit;
}

echo json_encode(["error"=>"unknown action"]);
