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
    $dbPath = $requestedPath ?: (getenv('JARVIS_INFRA_DB') ?: '/tmp/jarvis_infra.db');
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
    if (!is_dir($root)) {
        return [];
    }
    $iter = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS)
    );
    foreach ($iter as $fileInfo) {
        if (!$fileInfo instanceof SplFileInfo || !$fileInfo->isFile()) {
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
    if (!is_dir($root)) {
        return [];
    }
    $iter = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS)
    );
    foreach ($iter as $fileInfo) {
        if (!$fileInfo instanceof SplFileInfo || !$fileInfo->isFile()) {
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
    $realToolsRoot = realpath(tools_root()) ?: '';
    foreach (discover_manifest_paths(tools_root()) as $manifestPath) {
        $manifest = json_decode(file_get_contents($manifestPath) ?: '{}', true);
        if (!is_array($manifest)) {
            continue;
        }
        $entrypoint = (string)($manifest['entrypoint'] ?? 'tool.py');
        if (pathinfo($entrypoint, PATHINFO_EXTENSION) !== 'py') {
            continue;
        }
        $toolDir = dirname($manifestPath);
        $toolCodePath = realpath($toolDir . DIRECTORY_SEPARATOR . $entrypoint);
        if (!$toolCodePath || ($realToolsRoot !== '' && !str_starts_with($toolCodePath, $realToolsRoot))) {
            continue;
        }
        $sampleInput = [];
        if (isset($manifest['input_schema']) && is_array($manifest['input_schema'])) {
            $sample = sample_from_schema($manifest['input_schema']);
            if (is_array($sample)) {
                $sampleInput = $sample;
            }
        }
        $version = (string)($manifest['version'] ?? $manifest['tool_version'] ?? 'v0');
        $tools[] = [
            'name' => (string)($manifest['name'] ?? basename(dirname($manifestPath))),
            'version' => $version,
            'description' => (string)($manifest['description'] ?? ''),
            'entrypoint' => $entrypoint,
            'manifest_path' => str_replace(repo_root() . '/', '', $manifestPath),
            'code_path' => str_replace(repo_root() . '/', '', $toolCodePath),
            'sample_input' => $sampleInput,
            'required_fields' => $manifest['input_schema']['required'] ?? [],
            'input_schema' => $manifest['input_schema'] ?? new stdClass(),
            'output_schema' => $manifest['output_schema'] ?? new stdClass(),
            'action_types' => $manifest['action_types'] ?? [],
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
    return ['path' => str_replace(repo_root() . '/', '', $absPath), 'code' => $code];
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
    return ['path' => str_replace(repo_root() . '/', '', $absPath)];
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
    $defaultUrl = 'http://toolbox_runner:8030';
    if (!$pdo) {
        return $defaultUrl;
    }
    $stmt = $pdo->prepare('SELECT value FROM sensitive_values WHERE namespace = :namespace AND key = :key LIMIT 1');
    $stmt->execute([':namespace' => 'runtime', ':key' => 'TOOLBOX_RUNNER_URL']);
    $row = $stmt->fetch();
    $dbUrl = is_array($row) ? (string)($row['value'] ?? '') : '';
    return $dbUrl !== '' ? $dbUrl : $defaultUrl;
}

function list_tables(PDO $pdo): array {
    $stmt = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    return $stmt->fetchAll();
}

function get_table_rows(PDO $pdo, string $table, int $limit = 100, int $offset = 0): array {
    if (!preg_match('/^[a-zA-Z0-9_]+$/', $table)) {
        fail('nom de table invalide', 400);
    }
    $columns = $pdo->query('PRAGMA table_info(' . $table . ')')->fetchAll();
    $stmt = $pdo->prepare('SELECT * FROM ' . $table . ' LIMIT :limit OFFSET :offset');
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();
    return [
        'columns' => array_map(static fn(array $row) => $row['name'], $columns),
        'rows' => $stmt->fetchAll(),
    ];
}

function list_namespaces(PDO $pdo): array {
    $stmt = $pdo->query("SELECT DISTINCT namespace FROM sensitive_values ORDER BY namespace");
    return array_values(array_filter(array_map(static fn(array $r) => (string)($r['namespace'] ?? ''), $stmt->fetchAll())));
}

try {
    $payload = json_decode(file_get_contents('php://input') ?: '{}', true, flags: JSON_THROW_ON_ERROR);
    $action = $payload['action'] ?? null;
    if (!is_string($action) || $action === '') {
        fail('action manquante');
    }

    $pdo = connect_db(isset($payload['db_path']) ? (string)$payload['db_path'] : null);
    error_log('[config-web/api] action=' . $action . ' db=' . ((string)($payload['db_path'] ?? '')));

    switch ($action) {
        case 'healthcheck':
            $runnerUrl = toolbox_runner_url($pdo);
            $runnerHealth = null;
            $runnerError = null;
            $ch = curl_init(rtrim($runnerUrl, '/') . '/health');
            if ($ch !== false) {
                curl_setopt_array($ch, [
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT => 5,
                ]);
                $runnerRaw = curl_exec($ch);
                $runnerCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
                $runnerErr = curl_error($ch);
                curl_close($ch);
                if ($runnerRaw !== false && $runnerCode > 0) {
                    $decoded = json_decode($runnerRaw, true);
                    $runnerHealth = is_array($decoded) ? $decoded : ['raw' => $runnerRaw];
                } else {
                    $runnerError = $runnerErr ?: ('HTTP ' . $runnerCode);
                }
            }
            echo json_encode([
                'ok' => true,
                'repo_root' => repo_root(),
                'tools_root' => tools_root(),
                'tools_root_exists' => is_dir(tools_root()),
                'tools_count' => count(list_python_tools()),
                'python_files_count' => count(list_python_files()),
                'tools_preview' => array_slice(list_python_tools(), 0, 20),
                'python_files_preview' => array_slice(list_python_files(), 0, 50),
                'tables' => list_tables($pdo),
                'namespaces' => list_namespaces($pdo),
                'runner_url' => $runnerUrl,
                'runner_health' => $runnerHealth,
                'runner_error' => $runnerError,
            ]);
            break;

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
            echo json_encode(['ok' => true, 'item' => $item !== false ? $item : null]);
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

        default:
            fail("action inconnue: {$action}");
    }
} catch (JsonException $e) {
    fail('JSON invalide: ' . $e->getMessage());
} catch (Throwable $e) {
    error_log('[config-web/api] exception ' . $e->getMessage());
    fail($e->getMessage(), 500);
}
