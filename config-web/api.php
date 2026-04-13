<?php
declare(strict_types=1);

function json_response(array $data, int $status = 200): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $message, int $status = 400, array $extra = []): never {
    json_response(array_merge(['error' => $message], $extra), $status);
}

function repo_root(): string {
    return dirname(__DIR__);
}

function default_db_path(): string {
    return repo_root() . '/jarvis/database/db.db';
}

function allowed_roots(): array {
    return array_values(array_unique(array_filter([
        realpath(repo_root()) ?: repo_root(),
        realpath(dirname(repo_root())) ?: dirname(repo_root()),
    ])));
}

function is_allowed_path(string $path): bool {
    foreach (allowed_roots() as $root) {
        if ($root !== '' && str_starts_with($path, $root)) {
            return true;
        }
    }
    return false;
}

function resolve_existing_path(string $path): string {
    $real = realpath($path);
    if ($real === false) {
        fail('chemin introuvable: ' . $path, 404);
    }
    if (!is_allowed_path($real)) {
        fail('chemin hors périmètre autorisé', 403);
    }
    return $real;
}

function resolve_target_path(string $path): string {
    $path = trim($path);
    if ($path === '') {
        fail('chemin cible requis');
    }
    $absolute = str_starts_with($path, '/') ? $path : (repo_root() . '/' . $path);
    $parent = realpath(dirname($absolute));
    if ($parent === false || !is_dir($parent)) {
        fail('dossier parent introuvable pour la cible', 400);
    }
    if (!is_allowed_path($parent)) {
        fail('dossier cible hors périmètre autorisé', 403);
    }
    return rtrim($parent, '/') . '/' . basename($absolute);
}

function parse_payload(): array {
    $isMultipart = isset($_SERVER['CONTENT_TYPE']) && str_contains((string)$_SERVER['CONTENT_TYPE'], 'multipart/form-data');
    if ($isMultipart) {
        return $_POST;
    }
    $raw = file_get_contents('php://input') ?: '{}';
    try {
        $decoded = json_decode($raw, true, flags: JSON_THROW_ON_ERROR);
        return is_array($decoded) ? $decoded : [];
    } catch (Throwable $e) {
        fail('JSON invalide: ' . $e->getMessage(), 400);
    }
}

function connect_db(?string $requestedPath): PDO {
    $dbPath = $requestedPath ?: (getenv('JARVIS_INFRA_DB') ?: default_db_path());
    $dir = dirname($dbPath);
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
        fail('impossible de créer le dossier de la DB', 500);
    }
    $pdo = new PDO('sqlite:' . $dbPath);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    ensure_infra_schema($pdo);
    return $pdo;
}

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
        scheme TEXT NOT NULL DEFAULT 'http'
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
        path TEXT NOT NULL
    )");
}

function db_contract(): array {
    return [
        'db_path_resolution' => ['payload.db_path', 'env.JARVIS_INFRA_DB', default_db_path()],
        'tables' => [
            ['name' => 'sensitive_values', 'used_by' => ['config-web', 'npm_service', 'proxmox_ct'], 'columns' => ['namespace', 'key', 'value', 'updated_at']],
            ['name' => 'npm_instances', 'used_by' => ['npm_service'], 'columns' => ['name', 'base_url', 'login', 'password', 'password_secret_key']],
            ['name' => 'npm_services', 'used_by' => ['npm_service'], 'columns' => ['domain', 'instance_name', 'forward_host', 'forward_port', 'scheme']],
            ['name' => 'proxmox_targets', 'used_by' => ['proxmox_ct'], 'columns' => ['name', 'ip', 'api_path', 'login', 'password', 'password_secret_key', 'node']],
            ['name' => 'ct_services', 'used_by' => ['proxmox_ct'], 'columns' => ['name', 'target_name', 'ctid', 'path']],
            ['name' => 'devlab_runs', 'used_by' => ['devlab_backend'], 'columns' => ['run_id', 'tool_name', 'mode', 'status', 'started_at', 'ended_at', 'duration_ms', 'summary', 'payload_json', 'output_json', 'trace_json', 'diag_json']],
        ],
    ];
}

function tools_root(): string {
    return repo_root() . '/jarvis/toolbox/tools';
}

function discover_manifest_paths(string $root): array {
    if (!is_dir($root)) return [];
    $paths = [];
    $iter = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS));
    foreach ($iter as $fileInfo) {
        if ($fileInfo instanceof SplFileInfo && $fileInfo->isFile() && $fileInfo->getFilename() === 'manifest.json') {
            $paths[] = $fileInfo->getPathname();
        }
    }
    sort($paths);
    return $paths;
}

function discover_python_paths(string $root): array {
    if (!is_dir($root)) return [];
    $paths = [];
    $iter = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS));
    foreach ($iter as $fileInfo) {
        if ($fileInfo instanceof SplFileInfo && $fileInfo->isFile() && $fileInfo->getExtension() === 'py') {
            $paths[] = $fileInfo->getPathname();
        }
    }
    sort($paths);
    return $paths;
}

function sample_from_schema(array $schema): mixed {
    if (array_key_exists('default', $schema)) return $schema['default'];
    if (isset($schema['enum']) && is_array($schema['enum']) && count($schema['enum']) > 0) return $schema['enum'][0];
    $type = $schema['type'] ?? null;
    if ($type === 'object') {
        $out = [];
        foreach (($schema['properties'] ?? []) as $name => $childSchema) {
            if (is_string($name) && is_array($childSchema)) $out[$name] = sample_from_schema($childSchema);
        }
        return $out;
    }
    if ($type === 'array') return [];
    if ($type === 'integer' || $type === 'number') return 0;
    if ($type === 'boolean') return false;
    if ($type === 'string') return '';
    return null;
}

function list_python_tools(): array {
    $tools = [];
    $realRoot = realpath(tools_root()) ?: '';
    foreach (discover_manifest_paths(tools_root()) as $manifestPath) {
        $manifest = json_decode(file_get_contents($manifestPath) ?: '{}', true);
        if (!is_array($manifest)) continue;
        $entrypoint = (string)($manifest['entrypoint'] ?? 'tool.py');
        if (pathinfo($entrypoint, PATHINFO_EXTENSION) !== 'py') continue;
        $toolDir = dirname($manifestPath);
        $toolCodePath = realpath($toolDir . DIRECTORY_SEPARATOR . $entrypoint);
        if (!$toolCodePath || ($realRoot !== '' && !str_starts_with($toolCodePath, $realRoot))) continue;
        $sampleInput = [];
        if (isset($manifest['input_schema']) && is_array($manifest['input_schema'])) {
            $sample = sample_from_schema($manifest['input_schema']);
            if (is_array($sample)) $sampleInput = $sample;
        }
        $tools[] = [
            'name' => (string)($manifest['name'] ?? basename(dirname($manifestPath))),
            'version' => (string)($manifest['version'] ?? $manifest['tool_version'] ?? 'v0'),
            'description' => (string)($manifest['description'] ?? ''),
            'entrypoint' => $entrypoint,
            'manifest_path' => str_replace(repo_root() . '/', '', $manifestPath),
            'code_path' => str_replace(repo_root() . '/', '', $toolCodePath),
            'sample_input' => $sampleInput,
            'required_fields' => $manifest['input_schema']['required'] ?? [],
            'input_schema' => $manifest['input_schema'] ?? new stdClass(),
        ];
    }
    return $tools;
}

function list_python_files(): array {
    $files = [];
    $realRoot = realpath(tools_root());
    if ($realRoot === false) return [];
    foreach (discover_python_paths(tools_root()) as $path) {
        $realPath = realpath($path);
        if ($realPath === false || !str_starts_with($realPath, $realRoot)) continue;
        $relativePath = str_replace(repo_root() . '/', '', $realPath);
        $toolDir = dirname($relativePath);
        $manifestPath = $toolDir . '/manifest.json';
        $files[] = [
            'path' => $relativePath,
            'filename' => basename($relativePath),
            'tool_dir' => $toolDir,
            'manifest_path' => $manifestPath,
            'manifest_exists' => is_file(repo_root() . '/' . $manifestPath),
            'size' => filesize($realPath) ?: 0,
            'mtime' => gmdate('c', filemtime($realPath) ?: time()),
        ];
    }
    return $files;
}

function list_tables(PDO $pdo): array {
    $stmt = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    return $stmt->fetchAll();
}

function get_table_rows(PDO $pdo, string $table, int $limit = 200, int $offset = 0): array {
    if (!preg_match('/^[a-zA-Z0-9_]+$/', $table)) fail('nom de table invalide', 400);
    $columns = $pdo->query('PRAGMA table_info(' . $table . ')')->fetchAll();
    $stmt = $pdo->prepare('SELECT * FROM ' . $table . ' LIMIT :limit OFFSET :offset');
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();
    return ['columns' => array_map(static fn(array $row) => $row['name'], $columns), 'rows' => $stmt->fetchAll()];
}

function list_namespaces(PDO $pdo): array {
    $stmt = $pdo->query("SELECT DISTINCT namespace FROM sensitive_values ORDER BY namespace");
    return array_values(array_filter(array_map(static fn(array $r) => (string)($r['namespace'] ?? ''), $stmt->fetchAll())));
}

function browse_paths(?string $path): array {
    $target = $path !== null && trim($path) !== '' ? trim($path) : dirname(default_db_path());
    $current = resolve_existing_path($target);
    if (!is_dir($current)) fail('le chemin doit être un dossier', 400);
    $items = [];
    $entries = scandir($current);
    if ($entries === false) fail('impossible de lire le dossier', 500);
    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        $full = $current . DIRECTORY_SEPARATOR . $entry;
        $real = realpath($full);
        if ($real === false || !is_allowed_path($real)) continue;
        $isDir = is_dir($real);
        if (!$isDir && !preg_match('/\.(db|sqlite|sqlite3)$/i', $entry)) continue;
        $items[] = [
            'name' => $entry,
            'path' => $real,
            'type' => $isDir ? 'dir' : 'file',
            'size' => $isDir ? null : (filesize($real) ?: 0),
            'writable' => is_writable($real),
        ];
    }
    usort($items, static function (array $a, array $b): int {
        if ($a['type'] !== $b['type']) return $a['type'] === 'dir' ? -1 : 1;
        return strcmp((string)$a['name'], (string)$b['name']);
    });
    $parent = dirname($current);
    return [
        'current_path' => $current,
        'parent_path' => $parent !== $current && is_allowed_path($parent) ? $parent : null,
        'items' => $items,
    ];
}

$payload = parse_payload();
$action = $payload['action'] ?? ($_GET['action'] ?? null);
if (!is_string($action) || $action === '') fail('action manquante');

$dbPath = isset($payload['db_path']) ? (string)$payload['db_path'] : (isset($_GET['db_path']) ? (string)$_GET['db_path'] : null);

switch ($action) {
    case 'healthcheck':
        $pdo = connect_db($dbPath);
        json_response([
            'ok' => true,
            'repo_root' => repo_root(),
            'default_db_path' => default_db_path(),
            'active_db_path' => $dbPath ?: (getenv('JARVIS_INFRA_DB') ?: default_db_path()),
            'tools_root' => tools_root(),
            'tools_root_exists' => is_dir(tools_root()),
            'tools_count' => count(list_python_tools()),
            'python_files_count' => count(list_python_files()),
            'tools_preview' => array_slice(list_python_tools(), 0, 12),
            'python_files_preview' => array_slice(list_python_files(), 0, 24),
            'tables' => list_tables($pdo),
            'namespaces' => list_namespaces($pdo),
        ]);
    case 'db_contract':
        json_response(['ok' => true, 'contract' => db_contract()]);
    case 'browse_db_paths':
        json_response(['ok' => true] + browse_paths(isset($payload['path']) ? (string)$payload['path'] : null));
    case 'create_db':
        $target = resolve_target_path((string)($payload['path'] ?? ''));
        if (file_exists($target)) fail('le fichier existe déjà', 409);
        $pdo = connect_db($target);
        unset($pdo);
        json_response(['ok' => true, 'path' => $target, 'created' => true]);
    case 'delete_db':
        $target = resolve_existing_path((string)($payload['path'] ?? ''));
        if (!preg_match('/\.(db|sqlite|sqlite3)$/i', $target)) fail('fichier DB attendu', 400);
        if (!is_writable($target)) fail('fichier non supprimable', 403);
        if (!unlink($target)) fail('suppression impossible', 500);
        json_response(['ok' => true, 'deleted' => true, 'path' => $target]);
    case 'download_db':
        $path = resolve_existing_path((string)($_GET['db_path'] ?? $dbPath ?? default_db_path()));
        if (!is_file($path)) fail('fichier DB introuvable', 404);
        header('Content-Type: application/octet-stream');
        header('Content-Disposition: attachment; filename="' . basename($path) . '"');
        header('Content-Length: ' . (string)filesize($path));
        readfile($path);
        exit;
    case 'import_db':
        $source = resolve_existing_path((string)($payload['source_path'] ?? ''));
        $target = resolve_target_path((string)($payload['target_path'] ?? ''));
        if (!is_file($source)) fail('source introuvable', 404);
        if (!copy($source, $target)) fail('copie impossible', 500);
        json_response(['ok' => true, 'source_path' => $source, 'target_path' => $target, 'imported' => true]);
    case 'export_db':
        $source = resolve_existing_path((string)($payload['source_path'] ?? $dbPath ?? default_db_path()));
        $target = resolve_target_path((string)($payload['target_path'] ?? ''));
        if (!copy($source, $target)) fail('export impossible', 500);
        json_response(['ok' => true, 'source_path' => $source, 'target_path' => $target, 'exported' => true]);
    case 'upload_db':
        if (!isset($_FILES['file']) || !is_array($_FILES['file'])) fail('fichier upload requis');
        $target = resolve_target_path((string)($payload['target_path'] ?? ($_POST['target_path'] ?? '')));
        $tmp = (string)($_FILES['file']['tmp_name'] ?? '');
        if ($tmp === '' || !is_uploaded_file($tmp)) fail('upload invalide', 400);
        if (!move_uploaded_file($tmp, $target)) fail('impossible de stocker le fichier uploadé', 500);
        json_response(['ok' => true, 'target_path' => $target, 'uploaded' => true]);
    case 'list_tables':
        $pdo = connect_db($dbPath);
        json_response(['ok' => true, 'items' => list_tables($pdo)]);
    case 'get_table_rows':
        $pdo = connect_db($dbPath);
        json_response(['ok' => true] + get_table_rows($pdo, (string)($payload['table'] ?? ''), (int)($payload['limit'] ?? 200), (int)($payload['offset'] ?? 0)));
    case 'list_namespaces':
        $pdo = connect_db($dbPath);
        json_response(['ok' => true, 'items' => list_namespaces($pdo)]);
    case 'list_sensitive':
        $pdo = connect_db($dbPath);
        $stmt = $pdo->prepare('SELECT namespace, key, value, updated_at FROM sensitive_values WHERE namespace = :namespace ORDER BY key');
        $stmt->execute([':namespace' => (string)($payload['namespace'] ?? '')]);
        json_response(['ok' => true, 'items' => $stmt->fetchAll()]);
    case 'upsert_sensitive':
        $pdo = connect_db($dbPath);
        $stmt = $pdo->prepare("INSERT INTO sensitive_values(namespace, key, value)
            VALUES(:namespace, :key, :value)
            ON CONFLICT(namespace, key) DO UPDATE SET value=excluded.value, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
        $stmt->execute([
            ':namespace' => (string)($payload['namespace'] ?? ''),
            ':key' => (string)($payload['key'] ?? ''),
            ':value' => (string)($payload['value'] ?? ''),
        ]);
        json_response(['ok' => true]);
    case 'delete_sensitive':
        $pdo = connect_db($dbPath);
        $stmt = $pdo->prepare('DELETE FROM sensitive_values WHERE namespace = :namespace AND key = :key');
        $stmt->execute([':namespace' => (string)($payload['namespace'] ?? ''), ':key' => (string)($payload['key'] ?? '')]);
        json_response(['ok' => true, 'deleted' => $stmt->rowCount() > 0]);
    case 'list_python_tools':
        json_response(['ok' => true, 'items' => list_python_tools()]);
    case 'list_python_files':
        json_response(['ok' => true, 'items' => list_python_files()]);
    default:
        fail('action inconnue: ' . $action, 400);
}
