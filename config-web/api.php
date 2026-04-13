<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');

function fail(string $message, int $status = 400, array $extra = []): never {
    http_response_code($status);
    echo json_encode(array_merge(['error' => $message], $extra), JSON_UNESCAPED_UNICODE);
    exit;
}
function parse_payload(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') return [];
    try {
        $payload = json_decode($raw, true, flags: JSON_THROW_ON_ERROR);
        return is_array($payload) ? $payload : [];
    } catch (Throwable $e) {
        fail('JSON invalide: ' . $e->getMessage(), 400);
    }
}
function as_string(array $src, string $key, bool $required = true): ?string {
    $value = $src[$key] ?? null;
    if ($value === null || $value === '') {
        if ($required) fail("champ requis: {$key}");
        return null;
    }
    return (string)$value;
}
function repo_root(): string { return dirname(__DIR__); }
function preferred_db_path(): string { return '/var/www/jarvis/database/jarvis_infra.db'; }
function default_db_path(): string {
    $preferred = preferred_db_path();
    return $preferred !== '' ? $preferred : repo_root() . '/jarvis/database/db.db';
}
function tools_root(): string { return repo_root() . '/jarvis/toolbox/tools'; }
function ensure_infra_schema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS sensitive_values (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY(namespace, key)
    )");
    $pdo->exec("CREATE TABLE IF NOT EXISTS npm_instances (
        name TEXT PRIMARY KEY,
        base_url TEXT NOT NULL,
        login TEXT NOT NULL,
        password TEXT,
        password_secret_key TEXT,
        CHECK ((password IS NOT NULL AND password_secret_key IS NULL) OR (password IS NULL AND password_secret_key IS NOT NULL))
    )");
    $pdo->exec("CREATE TABLE IF NOT EXISTS npm_services (
        domain TEXT PRIMARY KEY,
        instance_name TEXT NOT NULL,
        forward_host TEXT NOT NULL,
        forward_port INTEGER NOT NULL,
        scheme TEXT NOT NULL DEFAULT 'http',
        FOREIGN KEY(instance_name) REFERENCES npm_instances(name)
    )");
    $pdo->exec("CREATE TABLE IF NOT EXISTS proxmox_targets (
        name TEXT PRIMARY KEY,
        ip TEXT NOT NULL,
        api_path TEXT NOT NULL DEFAULT '/api2/json',
        login TEXT NOT NULL,
        password TEXT,
        password_secret_key TEXT,
        node TEXT NOT NULL,
        CHECK ((password IS NOT NULL AND password_secret_key IS NULL) OR (password IS NULL AND password_secret_key IS NOT NULL))
    )");
    $pdo->exec("CREATE TABLE IF NOT EXISTS ct_services (
        name TEXT PRIMARY KEY,
        target_name TEXT NOT NULL,
        ctid INTEGER NOT NULL,
        path TEXT NOT NULL,
        FOREIGN KEY(target_name) REFERENCES proxmox_targets(name)
    )");
}
function connect_db(?string $requestedPath): PDO {
    $dbPath = $requestedPath ?: (getenv('JARVIS_INFRA_DB') ?: default_db_path());
    $dir = dirname($dbPath);
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) fail('impossible de créer le dossier de la DB', 500);
    $pdo = new PDO('sqlite:' . $dbPath);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    ensure_infra_schema($pdo);
    return $pdo;
}
function db_health(string $path): array {
    $exists = is_file($path);
    $dir = dirname($path);
    $dirExists = is_dir($dir);
    $sqliteOpenOk = false;
    $sqliteError = null;
    if ($exists && is_readable($path)) {
        try { $pdo = new PDO('sqlite:' . $path); $pdo->query('SELECT 1'); $sqliteOpenOk = true; } catch (Throwable $e) { $sqliteError = $e->getMessage(); }
    }
    return [
        'path' => $path,
        'exists' => $exists,
        'readable' => $exists ? is_readable($path) : false,
        'writable' => $exists ? is_writable($path) : ($dirExists && is_writable($dir)),
        'dir' => $dir,
        'dir_exists' => $dirExists,
        'dir_writable' => $dirExists && is_writable($dir),
        'sqlite_open_ok' => $sqliteOpenOk,
        'sqlite_error' => $sqliteError,
        'preferred_db_path' => preferred_db_path(),
    ];
}
function allowed_roots(): array {
    return array_values(array_unique(array_filter([
        '/var/www',
        repo_root(),
        dirname(repo_root()),
    ], fn($v) => is_string($v) && $v !== '')));
}
function is_allowed_path(string $path): bool {
    foreach (allowed_roots() as $root) {
        if ($path === $root || str_starts_with($path, rtrim($root, '/') . '/')) return true;
    }
    return false;
}
function normalize_existing_dir(string $path): string {
    $real = realpath($path);
    if ($real === false || !is_dir($real)) fail('dossier introuvable: ' . $path, 404);
    if (!is_allowed_path($real)) fail('dossier hors périmètre autorisé', 403, ['path' => $real, 'allowed_roots' => allowed_roots()]);
    return $real;
}
function normalize_target_file(string $path): string {
    $path = trim($path);
    if ($path === '') fail('chemin fichier requis');
    $absolute = str_starts_with($path, '/') ? $path : repo_root() . '/' . $path;
    $parent = dirname($absolute);
    $realParent = realpath($parent);
    if ($realParent === false || !is_dir($realParent)) fail('dossier parent introuvable', 400, ['parent' => $parent]);
    if (!is_allowed_path($realParent)) fail('dossier parent hors périmètre autorisé', 403, ['parent' => $realParent, 'allowed_roots' => allowed_roots()]);
    $basename = basename($absolute);
    if (!preg_match('/\.(db|sqlite|sqlite3)$/i', $basename)) fail('le fichier doit se terminer par .db', 400);
    return rtrim($realParent, '/') . '/' . $basename;
}
function browse_paths(?string $path): array {
    $target = ($path !== null && trim($path) !== '') ? trim($path) : dirname(default_db_path());
    $dir = normalize_existing_dir(is_file($target) ? dirname($target) : $target);
    $entries = scandir($dir);
    if ($entries === false) fail('impossible de lire le dossier', 500);
    $items = [];
    foreach ($entries as $entry) {
        if ($entry === '.') continue;
        $full = $dir . DIRECTORY_SEPARATOR . $entry;
        if ($entry === '..') {
            $parent = dirname($dir);
            if ($parent !== $dir && is_allowed_path($parent)) $items[] = ['name'=>'..','path'=>$parent,'type'=>'dir'];
            continue;
        }
        $real = realpath($full);
        if ($real === false || !is_allowed_path($real)) continue;
        if (is_dir($real)) { $items[] = ['name'=>$entry,'path'=>$real,'type'=>'dir']; continue; }
        if (preg_match('/\.(db|sqlite|sqlite3)$/i', $entry)) $items[] = ['name'=>$entry,'path'=>$real,'type'=>'file','size'=>filesize($real) ?: 0];
    }
    usort($items, fn($a,$b)=> $a['type']!==$b['type'] ? ($a['type']==='dir'?-1:1) : strcmp((string)$a['name'], (string)$b['name']));
    return ['current_path'=>$dir,'items'=>$items,'allowed_roots'=>allowed_roots()];
}
function create_db_at(string $targetPath): array {
    $target = normalize_target_file($targetPath);
    if (is_file($target)) return ['ok'=>true,'path'=>$target,'message'=>'db already exists','db'=>db_health($target)];
    $dir = dirname($target);
    if (!is_dir($dir) || !is_writable($dir)) fail('dossier parent non accessible en écriture', 400, ['dir'=>$dir]);
    try { $pdo = new PDO('sqlite:' . $target); ensure_infra_schema($pdo); $pdo = null; } catch (Throwable $e) { fail($e->getMessage(),500,['path'=>$target]);}
    return ['ok'=>true,'path'=>$target,'db'=>db_health($target)];
}
function delete_db_at(string $targetPath): array {
    $target = normalize_target_file($targetPath);
    if (!is_file($target)) fail('db introuvable',404,['path'=>$target]);
    if (!unlink($target)) fail('suppression impossible',500,['path'=>$target]);
    return ['ok'=>true,'deleted'=>$target];
}
function list_tables(PDO $pdo): array { return $pdo->query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")->fetchAll(); }
function table_exists(PDO $pdo,string $table): bool { $stmt=$pdo->prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=:name LIMIT 1"); $stmt->execute([':name'=>$table]); return (bool)$stmt->fetchColumn(); }
function get_table_columns(PDO $pdo,string $table): array { if(!preg_match('/^[a-zA-Z0-9_]+$/',$table)) fail('nom de table invalide'); $rows=$pdo->query('PRAGMA table_info('.$table.')')->fetchAll(); return array_values(array_map(static fn(array $row)=>(string)$row['name'],$rows)); }
function get_table_rows(PDO $pdo,string $table,int $limit=100,int $offset=0): array { $columns=get_table_columns($pdo,$table); $stmt=$pdo->prepare('SELECT * FROM '.$table.' LIMIT :limit OFFSET :offset'); $stmt->bindValue(':limit',$limit,PDO::PARAM_INT); $stmt->bindValue(':offset',$offset,PDO::PARAM_INT); $stmt->execute(); return ['columns'=>$columns,'rows'=>$stmt->fetchAll()]; }
function list_namespaces(PDO $pdo): array { if(!table_exists($pdo,'sensitive_values')) return []; $stmt=$pdo->query("SELECT DISTINCT namespace FROM sensitive_values ORDER BY namespace"); return array_values(array_map(static fn(array $row)=>(string)$row['namespace'],$stmt->fetchAll())); }
function list_sensitive(PDO $pdo,string $namespace): array { $stmt=$pdo->prepare("SELECT namespace,key,value,updated_at FROM sensitive_values WHERE namespace=:namespace ORDER BY key"); $stmt->execute([':namespace'=>$namespace]); return $stmt->fetchAll(); }
function upsert_sensitive(PDO $pdo,string $namespace,string $key,string $value): void { $stmt=$pdo->prepare("INSERT INTO sensitive_values(namespace,key,value) VALUES(:namespace,:key,:value) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"); $stmt->execute([':namespace'=>$namespace,':key'=>$key,':value'=>$value]); }
function delete_sensitive(PDO $pdo,string $namespace,string $key): bool { $stmt=$pdo->prepare("DELETE FROM sensitive_values WHERE namespace=:namespace AND key=:key"); $stmt->execute([':namespace'=>$namespace,':key'=>$key]); return $stmt->rowCount()>0; }
function normalize_tool_version(array $manifest): string { $version=(string)($manifest['version']??$manifest['tool_version']??'v0'); return $version!==''?$version:'v0'; }
function discover_manifest_paths(string $root): array { if(!is_dir($root)) return []; $paths=[]; $it=new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root,FilesystemIterator::SKIP_DOTS)); foreach($it as $f){ if($f instanceof SplFileInfo && $f->isFile() && $f->getFilename()==='manifest.json') $paths[]=$f->getPathname(); } sort($paths); return $paths; }
function discover_python_paths(string $root): array { if(!is_dir($root)) return []; $paths=[]; $it=new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root,FilesystemIterator::SKIP_DOTS)); foreach($it as $f){ if($f instanceof SplFileInfo && $f->isFile() && $f->getExtension()==='py') $paths[]=$f->getPathname(); } sort($paths); return $paths; }
function sample_from_schema(array $schema): mixed {
    if(array_key_exists('default',$schema)) return $schema['default'];
    if(isset($schema['enum'])&&is_array($schema['enum'])&&count($schema['enum'])>0) return $schema['enum'][0];
    $type=$schema['type']??null;
    if($type==='object'){ $out=[]; $props=$schema['properties']??[]; if(!is_array($props)) return new stdClass(); foreach($props as $name=>$child){ if(is_string($name)&&is_array($child)) $out[$name]=sample_from_schema($child);} return $out; }
    if($type==='array') return []; if($type==='integer'||$type==='number') return 0; if($type==='boolean') return false; if($type==='string') return ''; return null;
}
function list_python_tools(): array {
    $tools=[]; $realRoot=realpath(tools_root())?:'';
    foreach(discover_manifest_paths(tools_root()) as $manifestPath){
        $manifest=json_decode(file_get_contents($manifestPath)?:'{}',true);
        if(!is_array($manifest)) continue;
        $entry=(string)($manifest['entrypoint']??'tool.py');
        if(pathinfo($entry,PATHINFO_EXTENSION)!=='py') continue;
        $toolDir=dirname($manifestPath); $codePath=realpath($toolDir.DIRECTORY_SEPARATOR.$entry);
        if(!$codePath||($realRoot!==''&&!str_starts_with($codePath,$realRoot))) continue;
        $sampleInput=[]; if(isset($manifest['input_schema'])&&is_array($manifest['input_schema'])){ $sample=sample_from_schema($manifest['input_schema']); if(is_array($sample)) $sampleInput=$sample; }
        $tools[]=['name'=>(string)($manifest['name']??basename(dirname($manifestPath))),'version'=>normalize_tool_version($manifest),'description'=>(string)($manifest['description']??''),'entrypoint'=>$entry,'manifest_path'=>str_replace(repo_root().'/', '', $manifestPath),'code_path'=>str_replace(repo_root().'/', '', $codePath),'sample_input'=>$sampleInput,'required_fields'=>$manifest['input_schema']['required']??[],'input_schema'=>$manifest['input_schema']??new stdClass()];
    } return $tools;
}
function list_python_files(): array {
    $files=[]; $realRoot=realpath(tools_root()); if($realRoot===false) return [];
    foreach(discover_python_paths(tools_root()) as $path){ $realPath=realpath($path); if($realPath===false||!str_starts_with($realPath,$realRoot)) continue; $relative=str_replace(repo_root().'/', '', $realPath); $toolDir=dirname($relative); $manifestPath=$toolDir.'/manifest.json'; $files[]=['path'=>$relative,'tool_dir'=>$toolDir,'filename'=>basename($relative),'manifest_exists'=>is_file(repo_root().'/'.$manifestPath),'size'=>filesize($realPath)?:0,'mtime'=>gmdate('c', filemtime($realPath) ?: time())]; }
    return $files;
}
function read_python_file(string $relativePath): array {
    $abs = realpath(repo_root().'/'.$relativePath); $realRoot=realpath(tools_root());
    if(!$abs||!$realRoot||!str_starts_with($abs,$realRoot)) fail('fichier Python hors périmètre autorisé',403);
    if(!is_file($abs)||pathinfo($abs,PATHINFO_EXTENSION)!=='py') fail('fichier Python introuvable',404);
    $code=file_get_contents($abs); if($code===false) fail('impossible de lire le fichier Python',500);
    return ['path'=>str_replace(repo_root().'/', '', $abs), 'code'=>$code];
}
function save_python_file(string $relativePath,string $code): array {
    $abs = realpath(repo_root().'/'.$relativePath); $realRoot=realpath(tools_root());
    if(!$abs||!$realRoot||!str_starts_with($abs,$realRoot)) fail('fichier Python hors périmètre autorisé',403);
    if(!is_file($abs)||pathinfo($abs,PATHINFO_EXTENSION)!=='py') fail('fichier Python introuvable',404);
    if(file_put_contents($abs,$code)===false) fail('impossible de sauvegarder le fichier Python',500);
    return ['path'=>str_replace(repo_root().'/', '', $abs)];
}
function find_tool(array $tools,string $name): ?array { foreach($tools as $t){ if(($t['name']??'')===$name) return $t; } return null; }
function toolbox_runner_url(PDO $pdo): string {
    $default='http://toolbox_runner:8030';
    $stmt=$pdo->prepare('SELECT value FROM sensitive_values WHERE namespace=:namespace AND key=:key LIMIT 1');
    $stmt->execute([':namespace'=>'runtime',':key'=>'TOOLBOX_RUNNER_URL']);
    $row=$stmt->fetch();
    $dbUrl=is_array($row)?(string)($row['value']??''):'';
    return $dbUrl!==''?$dbUrl:$default;
}

try {
    $payload = parse_payload();
    $action = $payload['action'] ?? null;
    if (!is_string($action) || $action === '') fail('action manquante');
    $dbPath = isset($payload['db_path']) ? (string)$payload['db_path'] : null;

    $nonDbActions = ['browse_db_paths','create_db','delete_db','download_db','db_health'];
    $pdo = in_array($action, $nonDbActions, true) ? null : connect_db($dbPath);

    switch ($action) {
        case 'db_health':
            echo json_encode(['ok'=>true,'db'=>db_health($dbPath ?: (getenv('JARVIS_INFRA_DB') ?: default_db_path()))], JSON_UNESCAPED_UNICODE); break;
        case 'browse_db_paths':
            echo json_encode(['ok'=>true] + browse_paths(isset($payload['path'])?(string)$payload['path']:null), JSON_UNESCAPED_UNICODE); break;
        case 'create_db':
            echo json_encode(create_db_at(as_string($payload,'path')), JSON_UNESCAPED_UNICODE); break;
        case 'delete_db':
            echo json_encode(delete_db_at(as_string($payload,'path')), JSON_UNESCAPED_UNICODE); break;
        case 'download_db':
            $path = $dbPath ?: (getenv('JARVIS_INFRA_DB') ?: default_db_path());
            $path = normalize_target_file($path);
            if (!is_file($path)) fail('fichier DB introuvable',404,['path'=>$path]);
            header_remove('Content-Type');
            header('Content-Type: application/octet-stream');
            header('Content-Disposition: attachment; filename="'.basename($path).'"');
            readfile($path);
            exit;

        case 'upsert_sensitive':
            upsert_sensitive($pdo, as_string($payload, 'namespace'), as_string($payload, 'key'), as_string($payload, 'value'));
            echo json_encode(['ok' => true]); break;
        case 'delete_sensitive':
            echo json_encode(['ok' => true, 'deleted' => delete_sensitive($pdo, as_string($payload,'namespace'), as_string($payload,'key'))]); break;
        case 'list_sensitive':
            echo json_encode(['items' => list_sensitive($pdo, as_string($payload,'namespace'))]); break;
        case 'get_sensitive':
            $stmt=$pdo->prepare('SELECT namespace,key,value,updated_at FROM sensitive_values WHERE namespace=:namespace AND key=:key LIMIT 1');
            $stmt->execute([':namespace'=>as_string($payload,'namespace'),':key'=>as_string($payload,'key')]);
            $item=$stmt->fetch();
            echo json_encode(['ok'=>true,'item'=>$item!==false?$item:null]); break;
        case 'list_python_tools':
            echo json_encode(['ok'=>true,'search_root'=>tools_root(),'search_manifest_pattern'=>'**/manifest.json','search_entrypoint_extension'=>'.py','items'=>list_python_tools()]); break;
        case 'list_python_files':
            echo json_encode(['ok'=>true,'search_root'=>tools_root(),'search_python_pattern'=>'**/*.py','items'=>list_python_files()]); break;
        case 'get_python_file':
            echo json_encode(['ok'=>true] + read_python_file(as_string($payload,'path'))); break;
        case 'save_python_file':
            echo json_encode(['ok'=>true] + save_python_file(as_string($payload,'path'), as_string($payload,'code'))); break;
        case 'run_python_tool':
            $toolName = as_string($payload, 'tool');
            $input = $payload['input'] ?? null;
            if (!is_array($input)) fail('champ input doit être un objet JSON');
            $runnerUrl = rtrim(toolbox_runner_url($pdo), '/');
            $url = $runnerUrl . '/v1/run';
            $requestBody = json_encode(['tool'=>$toolName,'input'=>$input], JSON_UNESCAPED_UNICODE);
            if ($requestBody === false) fail('impossible de sérialiser la requête run_tool',500);
            $ch=curl_init($url); if($ch===false) fail('impossible d\'initialiser cURL',500);
            curl_setopt_array($ch,[CURLOPT_POST=>true,CURLOPT_HTTPHEADER=>['Content-Type: application/json'],CURLOPT_POSTFIELDS=>$requestBody,CURLOPT_RETURNTRANSFER=>true,CURLOPT_TIMEOUT=>60]);
            $raw=curl_exec($ch); $httpCode=(int)curl_getinfo($ch,CURLINFO_HTTP_CODE); $curlError=curl_error($ch); curl_close($ch);
            if($raw===false) fail('erreur réseau toolbox_runner: '.$curlError,502);
            $json=json_decode($raw,true); if(!is_array($json)) fail('réponse non JSON de toolbox_runner',502);
            echo json_encode(['ok'=>true,'runner_url'=>$runnerUrl,'http_code'=>$httpCode,'response'=>$json]); break;
        default:
            fail("action inconnue: {$action}");
    }
} catch (JsonException $e) {
    fail('JSON invalide: ' . $e->getMessage());
} catch (Throwable $e) {
    fail($e->getMessage(), 500);
}
?>