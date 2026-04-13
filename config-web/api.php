<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

function fail(string $message, int $status = 400): never {
    http_response_code($status);
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function as_string(array $src, string $key, bool $required = true): ?string {
    $value = $src[$key] ?? null;
    if ($value === null || $value === '') {
        if ($required) {
            fail("champ requis: {$key}");
        }
        return null;
    }
    return (string)$value;
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

    $pdo->exec("CREATE TABLE IF NOT EXISTS sensitive_values (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY(namespace, key)
    )");

    return $pdo;
}

function repo_root(): string {
    return dirname(__DIR__);
}

function tools_root(): string {
    return repo_root() . '/jarvis/toolbox/tools';
}

function discover_manifest_paths(string $root): array {
    $paths = [];
    $iter = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS)
    );
    foreach ($iter as $fileInfo) {
        if (!$fileInfo instanceof SplFileInfo) {
            continue;
        }
        if (!$fileInfo->isFile()) {
            continue;
        }
        if ($fileInfo->getFilename() !== 'manifest.json') {
            continue;
        }
        $paths[] = $fileInfo->getPathname();
    }
    sort($paths);
    return $paths;
}

function discover_python_paths(string $root): array {
    $paths = [];
    $iter = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS)
    );
    foreach ($iter as $fileInfo) {
        if (!$fileInfo instanceof SplFileInfo) {
            continue;
        }
        if (!$fileInfo->isFile()) {
            continue;
        }
        if ($fileInfo->getExtension() !== 'py') {
            continue;
        }
        $paths[] = $fileInfo->getPathname();
    }
    sort($paths);
    return $paths;
}

function sample_from_schema(array $schema): mixed {
    if (array_key_exists('default', $schema)) {
        return $schema['default'];
    }
    if (isset($schema['enum']) && is_array($schema['enum']) && count($schema['enum']) > 0) {
        return $schema['enum'][0];
    }

    $type = $schema['type'] ?? null;
    if ($type === 'object') {
        $out = [];
        $properties = $schema['properties'] ?? [];
        if (!is_array($properties)) {
            return new stdClass();
        }

        foreach ($properties as $name => $childSchema) {
            if (!is_string($name) || !is_array($childSchema)) {
                continue;
            }
            $out[$name] = sample_from_schema($childSchema);
        }
        return $out;
    }
    if ($type === 'array') {
        return [];
    }
    if ($type === 'integer' || $type === 'number') {
        return 0;
    }
    if ($type === 'boolean') {
        return false;
    }
    if ($type === 'string') {
        return '';
    }
    return null;
}

function list_python_tools(): array {
    $tools = [];
    $manifestPaths = discover_manifest_paths(tools_root());

    foreach ($manifestPaths as $manifestPath) {
        $manifest = json_decode(file_get_contents($manifestPath) ?: '{}', true);
        if (!is_array($manifest)) {
            continue;
        }

        $entrypoint = (string)($manifest['entrypoint'] ?? 'tool.py');
        if (pathinfo($entrypoint, PATHINFO_EXTENSION) !== 'py') {
            continue;
        }

        $toolName = (string)($manifest['name'] ?? basename(dirname($manifestPath)));
        $toolDir = dirname($manifestPath);
        $toolCodePath = realpath($toolDir . DIRECTORY_SEPARATOR . $entrypoint);
        if (!$toolCodePath || !str_starts_with($toolCodePath, realpath(tools_root()))) {
            continue;
        }

        $sampleInput = [];
        if (isset($manifest['input_schema']) && is_array($manifest['input_schema'])) {
            $sample = sample_from_schema($manifest['input_schema']);
            if (is_array($sample)) {
                $sampleInput = $sample;
            }
        }

        $tools[] = [
            'name' => $toolName,
            'entrypoint' => $entrypoint,
            'manifest_path' => str_replace(repo_root() . '/', '', $manifestPath),
            'code_path' => str_replace(repo_root() . '/', '', $toolCodePath),
            'sample_input' => $sampleInput,
            'required_fields' => $manifest['input_schema']['required'] ?? [],
        ];
    }

    return $tools;
}

function list_python_files(): array {
    $files = [];
    $root = tools_root();
    $realRoot = realpath($root);
    if ($realRoot === false) {
        return [];
    }

    foreach (discover_python_paths($root) as $path) {
        $realPath = realpath($path);
        if ($realPath === false || !str_starts_with($realPath, $realRoot)) {
            continue;
        }

        $relativePath = str_replace(repo_root() . '/', '', $realPath);
        $toolDir = dirname($relativePath);
        $manifestPath = $toolDir . '/manifest.json';
        $manifestExists = is_file(repo_root() . '/' . $manifestPath);

        $files[] = [
            'path' => $relativePath,
            'tool_dir' => $toolDir,
            'filename' => basename($relativePath),
            'manifest_path' => $manifestPath,
            'manifest_exists' => $manifestExists,
            'size' => filesize($realPath) ?: 0,
            'mtime' => gmdate('c', filemtime($realPath) ?: time()),
        ];
    }

    return $files;
}

function read_python_file(string $relativePath): array {
    $absPath = realpath(repo_root() . '/' . $relativePath);
    $realRoot = realpath(tools_root());
    if (!$absPath || !$realRoot || !str_starts_with($absPath, $realRoot)) {
        fail('fichier Python hors périmètre autorisé', 403);
    }
    if (!is_file($absPath) || pathinfo($absPath, PATHINFO_EXTENSION) !== 'py') {
        fail('fichier Python introuvable', 404);
    }
    $code = file_get_contents($absPath);
    if ($code === false) {
        fail('impossible de lire le fichier Python', 500);
    }

    return [
        'path' => str_replace(repo_root() . '/', '', $absPath),
        'code' => $code,
    ];
}

function save_python_file(string $relativePath, string $code): array {
    $absPath = realpath(repo_root() . '/' . $relativePath);
    $realRoot = realpath(tools_root());
    if (!$absPath || !$realRoot || !str_starts_with($absPath, $realRoot)) {
        fail('fichier Python hors périmètre autorisé', 403);
    }
    if (!is_file($absPath) || pathinfo($absPath, PATHINFO_EXTENSION) !== 'py') {
        fail('fichier Python introuvable', 404);
    }
    if (file_put_contents($absPath, $code) === false) {
        fail('impossible de sauvegarder le fichier Python', 500);
    }
    return [
        'path' => str_replace(repo_root() . '/', '', $absPath),
    ];
}

function find_tool(array $tools, string $name): ?array {
    foreach ($tools as $tool) {
        if (($tool['name'] ?? '') === $name) {
            return $tool;
        }
    }
    return null;
}

function toolbox_runner_url(?PDO $pdo): string {
    $defaultUrl = 'http://localhost:8030';
    if (!$pdo) {
        return $defaultUrl;
    }
    $stmt = $pdo->prepare('SELECT value FROM sensitive_values WHERE namespace = :namespace AND key = :key LIMIT 1');
    $stmt->execute([':namespace' => 'runtime', ':key' => 'TOOLBOX_RUNNER_URL']);
    $row = $stmt->fetch();
    $dbUrl = is_array($row) ? (string)($row['value'] ?? '') : '';
    return $dbUrl !== '' ? $dbUrl : $defaultUrl;
}


function default_db_path(): string {
    return getenv('JARVIS_INFRA_DB') ?: (repo_root() . '/jarvis/database/db.db');
}

function is_allowed_path(string $path): bool {
    $allowedRoots = [
        realpath(repo_root()) ?: repo_root(),
        realpath(dirname(repo_root())) ?: dirname(repo_root()),
    ];
    foreach ($allowedRoots as $root) {
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

function browse_paths(?string $path): array {
    $target = $path !== null && trim($path) !== '' ? trim($path) : dirname(default_db_path());
    $current = resolve_existing_path($target);
    if (!is_dir($current)) {
        fail('le chemin doit être un dossier', 400);
    }
    $items = [];
    $entries = scandir($current);
    if ($entries === false) {
        fail('impossible de lire le dossier', 500);
    }
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

try {
    $isMultipart = isset($_SERVER['CONTENT_TYPE']) && str_contains((string)$_SERVER['CONTENT_TYPE'], 'multipart/form-data');
    $payload = $isMultipart ? $_POST : json_decode(file_get_contents('php://input') ?: '{}', true, flags: JSON_THROW_ON_ERROR);
    $action = $payload['action'] ?? ($_GET['action'] ?? null);
    if (!is_string($action) || $action === '') {
        fail('action manquante');
    }

    $pdo = connect_db(isset($payload['db_path']) ? (string)$payload['db_path'] : null);

    switch ($action) {
        case 'upsert_sensitive':
            $stmt = $pdo->prepare("INSERT INTO sensitive_values(namespace, key, value)
                VALUES(:namespace, :key, :value)
                ON CONFLICT(namespace, key) DO UPDATE SET
                    value=excluded.value,
                    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
            $stmt->execute([
                ':namespace' => as_string($payload, 'namespace'),
                ':key' => as_string($payload, 'key'),
                ':value' => as_string($payload, 'value'),
            ]);
            echo json_encode(['ok' => true]);
            break;

        case 'delete_sensitive':
            $stmt = $pdo->prepare('DELETE FROM sensitive_values WHERE namespace = :namespace AND key = :key');
            $stmt->execute([
                ':namespace' => as_string($payload, 'namespace'),
                ':key' => as_string($payload, 'key'),
            ]);
            echo json_encode(['ok' => true, 'deleted' => $stmt->rowCount() > 0]);
            break;

        case 'list_sensitive':
            $stmt = $pdo->prepare('SELECT namespace, key, value, updated_at FROM sensitive_values WHERE namespace = :namespace ORDER BY key');
            $stmt->execute([':namespace' => as_string($payload, 'namespace')]);
            echo json_encode(['items' => $stmt->fetchAll()]);
            break;

        case 'get_sensitive':
            $stmt = $pdo->prepare('SELECT namespace, key, value, updated_at FROM sensitive_values WHERE namespace = :namespace AND key = :key LIMIT 1');
            $stmt->execute([
                ':namespace' => as_string($payload, 'namespace'),
                ':key' => as_string($payload, 'key'),
            ]);
            $item = $stmt->fetch();
            echo json_encode([
                'ok' => true,
                'item' => $item !== false ? $item : null,
            ]);
            break;

        case 'list_python_tools':
            echo json_encode([
                'ok' => true,
                'search_root' => tools_root(),
                'search_manifest_pattern' => '**/manifest.json',
                'search_entrypoint_extension' => '.py',
                'items' => list_python_tools(),
            ]);
            break;

        case 'list_python_files':
            echo json_encode([
                'ok' => true,
                'search_root' => tools_root(),
                'search_python_pattern' => '**/*.py',
                'items' => list_python_files(),
            ]);
            break;

        case 'get_tool_code':
            $toolName = as_string($payload, 'tool');
            $tools = list_python_tools();
            $tool = find_tool($tools, $toolName);
            if (!$tool) {
                fail("outil introuvable: {$toolName}", 404);
            }
            $absPath = repo_root() . '/' . $tool['code_path'];
            $code = file_get_contents($absPath);
            if ($code === false) {
                fail('impossible de lire le code outil', 500);
            }
            echo json_encode(['ok' => true, 'path' => $tool['code_path'], 'code' => $code]);
            break;

        case 'get_python_file':
            $path = as_string($payload, 'path');
            echo json_encode(['ok' => true] + read_python_file($path));
            break;

        case 'save_tool_code':
            $toolName = as_string($payload, 'tool');
            $code = as_string($payload, 'code');
            $tools = list_python_tools();
            $tool = find_tool($tools, $toolName);
            if (!$tool) {
                fail("outil introuvable: {$toolName}", 404);
            }
            $absPath = repo_root() . '/' . $tool['code_path'];
            if (file_put_contents($absPath, $code) === false) {
                fail('impossible de sauvegarder le code outil', 500);
            }
            echo json_encode(['ok' => true, 'path' => $tool['code_path']]);
            break;

        case 'save_python_file':
            $path = as_string($payload, 'path');
            $code = as_string($payload, 'code');
            echo json_encode(['ok' => true] + save_python_file($path, $code));
            break;

        case 'run_python_tool':
            $toolName = as_string($payload, 'tool');
            $input = $payload['input'] ?? null;
            if (!is_array($input)) {
                fail('champ input doit être un objet JSON');
            }
            $runnerUrl = rtrim(toolbox_runner_url($pdo), '/');
            $url = $runnerUrl . '/v1/run';
            $requestBody = json_encode(['tool' => $toolName, 'input' => $input], JSON_UNESCAPED_UNICODE);
            if ($requestBody === false) {
                fail('impossible de sérialiser la requête run_tool', 500);
            }

            $ch = curl_init($url);
            if ($ch === false) {
                fail('impossible d\'initialiser cURL', 500);
            }
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
                CURLOPT_POSTFIELDS => $requestBody,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 60,
            ]);

            $raw = curl_exec($ch);
            $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $curlError = curl_error($ch);
            curl_close($ch);

            if ($raw === false) {
                fail('erreur réseau toolbox_runner: ' . $curlError, 502);
            }

            $json = json_decode($raw, true);
            if (!is_array($json)) {
                fail('réponse non JSON de toolbox_runner', 502);
            }

            echo json_encode([
                'ok' => true,
                'runner_url' => $runnerUrl,
                'http_code' => $httpCode,
                'response' => $json,
            ]);
            break;


case 'list_tables':
    echo json_encode(['ok' => true, 'items' => list_tables($pdo)]);
    break;

case 'get_table_rows':
    $table = as_string($payload, 'table');
    $limit = isset($payload['limit']) ? max(1, min(500, (int)$payload['limit'])) : 100;
    $offset = isset($payload['offset']) ? max(0, (int)$payload['offset']) : 0;
    echo json_encode(['ok' => true] + get_table_rows($pdo, $table, $limit, $offset));
    break;

case 'browse_paths':
    echo json_encode(['ok' => true] + browse_paths(isset($payload['path']) ? (string)$payload['path'] : null));
    break;

case 'create_db':
    $targetDir = isset($payload['target_dir']) && (string)$payload['target_dir'] !== '' ? (string)$payload['target_dir'] : dirname(default_db_path());
    $filename = as_string($payload, 'filename');
    if (!preg_match('/\.(db|sqlite|sqlite3)$/i', $filename)) {
        $filename .= '.db';
    }
    $target = resolve_target_path(rtrim($targetDir, '/') . '/' . $filename);
    if (is_file($target)) {
        fail('le fichier DB existe déjà', 409);
    }
    $pdoCreated = connect_db($target);
    unset($pdoCreated);
    echo json_encode(['ok' => true, 'target_path' => $target, 'size' => filesize($target) ?: 0]);
    break;

case 'delete_db':
    $target = resolve_existing_path(as_string($payload, 'target_path'));
    if (!is_file($target)) {
        fail('DB cible introuvable', 404);
    }
    if (!unlink($target)) {
        fail('échec suppression DB', 500);
    }
    echo json_encode(['ok' => true, 'deleted_path' => $target]);
    break;

case 'export_db':
    $sourcePath = isset($payload['db_path']) && (string)$payload['db_path'] !== '' ? (string)$payload['db_path'] : default_db_path();
    $source = resolve_existing_path($sourcePath);
    if (!is_file($source)) {
        fail('DB source introuvable', 404);
    }
    $target = resolve_target_path(as_string($payload, 'target_path'));
    if (!copy($source, $target)) {
        fail('échec export DB', 500);
    }
    echo json_encode(['ok' => true, 'source_path' => $source, 'target_path' => $target, 'size' => filesize($target) ?: 0]);
    break;

case 'download_db':
    $sourcePath = isset($_GET['db_path']) && (string)$_GET['db_path'] !== '' ? (string)$_GET['db_path'] : ((string)($payload['db_path'] ?? default_db_path()));
    $source = resolve_existing_path($sourcePath);
    if (!is_file($source)) {
        fail('DB source introuvable', 404);
    }
    header_remove('Content-Type');
    header('Content-Type: application/octet-stream');
    header('Content-Disposition: attachment; filename="' . basename($source) . '"');
    header('Content-Length: ' . ((string)(filesize($source) ?: 0)));
    readfile($source);
    break;

case 'upload_db':
    if (!isset($_FILES['file']) || !is_array($_FILES['file'])) {
        fail('fichier DB manquant');
    }
    $tmpPath = (string)($_FILES['file']['tmp_name'] ?? '');
    $originalName = (string)($_FILES['file']['name'] ?? 'upload.db');
    if ($tmpPath === '' || !is_uploaded_file($tmpPath)) {
        fail('upload invalide', 400);
    }
    if (!preg_match('/\.(db|sqlite|sqlite3)$/i', $originalName)) {
        fail('extension DB attendue (.db/.sqlite/.sqlite3)', 400);
    }
    $targetInput = isset($_POST['db_path']) && (string)$_POST['db_path'] !== '' ? (string)$_POST['db_path'] : default_db_path();
    $target = resolve_target_path($targetInput);
    if (!move_uploaded_file($tmpPath, $target)) {
        fail('échec remplacement DB cible', 500);
    }
    connect_db($target);
    echo json_encode(['ok' => true, 'uploaded_name' => $originalName, 'target_path' => $target, 'size' => filesize($target) ?: 0]);
    break;

default:
    fail("action inconnue: {$action}");

    }
} catch (JsonException $e) {
    fail('JSON invalide: ' . $e->getMessage());
} catch (Throwable $e) {
    fail($e->getMessage(), 500);
}
