<?php
declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(E_ALL);
header('Content-Type: application/json; charset=utf-8');

set_error_handler(function (int $severity, string $message, string $file, int $line): never {
    http_response_code(500);
    echo json_encode([
        'error' => 'php_error',
        'message' => $message,
        'file' => $file,
        'line' => $line,
    ], JSON_UNESCAPED_UNICODE);
    exit;
});

set_exception_handler(function (Throwable $e): never {
    http_response_code(500);
    echo json_encode([
        'error' => 'php_exception',
        'message' => $e->getMessage(),
        'file' => $e->getFile(),
        'line' => $e->getLine(),
    ], JSON_UNESCAPED_UNICODE);
    exit;
});

function json_response(array $data, int $status = 200): never {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}

function candidate_db_dirs(): array {
    $dirs = [];
    $env = getenv('JARVIS_DEVLAB_DB_DIR');
    if (is_string($env) && trim($env) !== '') $dirs[] = rtrim($env, '/');
    $dirs[] = '/opt/jarvis/database';
    $dirs[] = __DIR__ . '/data';
    $dirs[] = sys_get_temp_dir() . '/jarvis-devlab';
    return array_values(array_unique($dirs));
}

function ensure_dir(string $dir): bool {
    if (is_dir($dir)) return is_writable($dir);
    return @mkdir($dir, 0775, true) && is_writable($dir);
}

function db_path(): string {
    $envFile = getenv('JARVIS_DEVLAB_DB');
    if (is_string($envFile) && trim($envFile) !== '') {
        $parent = dirname($envFile);
        if (ensure_dir($parent)) return $envFile;
    }
    foreach (candidate_db_dirs() as $dir) {
        if (ensure_dir($dir)) return rtrim($dir, '/') . '/jarvis.db';
    }
    throw new RuntimeException('Aucun dossier inscriptible pour la DB SQLite.');
}


function normalize_db_candidate(string $path): string {
    $clean = trim($path);
    if ($clean === '') throw new RuntimeException('Chemin DB vide.');
    if (!str_starts_with($clean, '/')) throw new RuntimeException('Le chemin DB doit être absolu.');
    $parts = array_values(array_filter(explode('/', $clean), static fn(string $p): bool => $p !== '' && $p !== '.'));
    $out = [];
    foreach ($parts as $part) {
        if ($part === '..') {
            array_pop($out);
            continue;
        }
        $out[] = $part;
    }
    return '/' . implode('/', $out);
}

function allowed_db_roots(): array {
    $roots = candidate_db_dirs();
    $roots[] = '/var/www/jarvis/database';
    return array_values(array_unique(array_map(static fn(string $d): string => rtrim($d, '/'), $roots)));
}

function path_in_allowed_roots(string $path): bool {
    $normalized = normalize_db_candidate($path);
    foreach (allowed_db_roots() as $root) {
        if ($normalized === $root || str_starts_with($normalized, $root . '/')) return true;
    }
    return false;
}

function resolve_db_path(array $payload): string {
    $candidate = $payload['db_path'] ?? null;
    if (!is_string($candidate) || trim($candidate) === '') return db_path();
    $normalized = normalize_db_candidate($candidate);
    if (!path_in_allowed_roots($normalized)) throw new RuntimeException('db_path hors des dossiers autorisés.');
    $ext = strtolower(pathinfo($normalized, PATHINFO_EXTENSION));
    if (!in_array($ext, ['db', 'sqlite', 'sqlite3'], true)) throw new RuntimeException('Extension DB invalide.');
    return $normalized;
}

function repo_root(): string {
    $candidates = [realpath(__DIR__), realpath(dirname(__DIR__))];
    foreach ($candidates as $candidate) {
        if (is_string($candidate) && $candidate !== '' && is_dir($candidate . '/jarvis')) {
            return $candidate;
        }
    }
    return dirname(__DIR__);
}

function tools_root(): string { return repo_root() . '/jarvis/toolbox/tools'; }

function pdo(?string $path = null): PDO {
    static $pool = [];
    $dbPath = $path ?? db_path();
    if (isset($pool[$dbPath]) && $pool[$dbPath] instanceof PDO) return $pool[$dbPath];
    $conn = new PDO('sqlite:' . $dbPath);
    $conn->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $conn->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $conn->exec('PRAGMA foreign_keys = ON');
    ensure_schema($conn);
    $pool[$dbPath] = $conn;
    return $conn;
}

function ensure_schema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS infra_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS service_config_values (
        profile TEXT NOT NULL DEFAULT 'default',
        service_name TEXT NOT NULL,
        config_key TEXT NOT NULL,
        config_value TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY(profile, service_name, config_key)
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS devlab_runs (
        run_id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_name TEXT NOT NULL,
        engine TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT 'default',
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_ms INTEGER,
        summary TEXT,
        payload_json TEXT,
        output_json TEXT,
        stdout_text TEXT,
        stderr_text TEXT
    )");
}

function parse_payload(): array {
    $raw = file_get_contents('php://input');
    if (!is_string($raw) || trim($raw) === '') return [];
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) json_response(['error' => 'invalid_json'], 400);
    return $decoded;
}

function browse_db_paths(string $path): array {
    $target = normalize_db_candidate($path);
    if (!path_in_allowed_roots($target)) throw new RuntimeException('Chemin non autorisé.');
    if (!is_dir($target)) throw new RuntimeException('Le dossier demandé est introuvable.');
    $items = [];
    foreach (scandir($target) ?: [] as $name) {
        if ($name === '.' || $name === '..') continue;
        $full = $target . '/' . $name;
        if (is_dir($full)) {
            $items[] = ['name' => $name, 'path' => $full, 'type' => 'dir'];
            continue;
        }
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        if (is_file($full) && in_array($ext, ['db', 'sqlite', 'sqlite3'], true)) {
            $items[] = ['name' => $name, 'path' => $full, 'type' => 'file'];
        }
    }
    usort($items, static function(array $a, array $b): int {
        if ($a['type'] !== $b['type']) return $a['type'] === 'dir' ? -1 : 1;
        return strcmp($a['name'], $b['name']);
    });
    return ['current_path' => $target, 'items' => $items];
}

function safe_db_probe(?string $path = null): array {
    try {
        $path = $path ?? db_path();
        $dir = dirname($path);
        return [
            'ok' => true,
            'db_path' => $path,
            'db_dir' => $dir,
            'db_exists' => file_exists($path),
            'db_dir_writable' => is_dir($dir) && is_writable($dir),
        ];
    } catch (Throwable $e) {
        return ['ok' => false, 'db_error' => $e->getMessage()];
    }
}

function inspect_db_path(string $path): array {
    $normalized = normalize_db_candidate($path);
    $dir = dirname($normalized);
    $result = [
        'path' => $normalized,
        'dirname' => $dir,
        'exists' => file_exists($normalized),
        'is_file' => is_file($normalized),
        'readable' => is_readable($normalized),
        'writable' => is_writable($normalized),
        'dir_exists' => is_dir($dir),
        'dir_writable' => is_dir($dir) && is_writable($dir),
        'realpath' => realpath($normalized) ?: null,
        'allowed_root' => path_in_allowed_roots($normalized),
    ];

    try {
        $probe = new PDO('sqlite:' . $normalized);
        $probe->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $probe->query('SELECT 1');
        $result['pdo_open_ok'] = true;
        $result['pdo_error'] = null;
    } catch (Throwable $e) {
        $result['pdo_open_ok'] = false;
        $result['pdo_error'] = $e->getMessage();
    }

    $cmd = 'python3 -c ' . escapeshellarg(
        'import sqlite3,sys; p=sys.argv[1]; sqlite3.connect(p).execute("select 1"); print("ok")'
    ) . ' ' . escapeshellarg($normalized) . ' 2>&1';
    $out = [];
    $code = 0;
    exec($cmd, $out, $code);
    $result['python_sqlite_ok'] = $code === 0;
    $result['python_sqlite_output'] = implode("\n", $out);

    return $result;
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
        if ($fileInfo instanceof SplFileInfo && $fileInfo->isFile() && strtolower($fileInfo->getExtension()) === 'py') {
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
        foreach (($schema['properties'] ?? []) as $name => $child) {
            if (is_string($name) && is_array($child)) $out[$name] = sample_from_schema($child);
        }
        return $out;
    }
    if ($type === 'array') return [];
    if ($type === 'integer' || $type === 'number') return 0;
    if ($type === 'boolean') return false;
    if ($type === 'string') return '';
    return null;
}

function default_demo_service(): array {
    return [
        'name' => 'example_service',
        'description' => 'Service de démonstration pour vérifier UI, DB et API.',
        'engine_default' => 'plan_only',
        'manifest_path' => null,
        'tool_dir' => null,
        'entrypoint' => null,
        'sample_input' => ['message' => 'hello'],
        'required_fields' => ['message'],
        'config_requirements' => [
            ['namespace' => 'example_service', 'key' => 'API_URL', 'label' => 'API URL', 'required' => true],
            ['namespace' => 'example_service', 'key' => 'TOKEN', 'label' => 'Token', 'required' => false],
        ],
        'code_files' => [],
    ];
}

function inferred_config_requirements(string $serviceName, array $runtimeEnvKeys = []): array {
    $requirements = [];
    $keys = [];
    foreach ($runtimeEnvKeys as $key) {
        if (!is_string($key)) continue;
        $clean = trim($key);
        if ($clean !== '') $keys[] = $clean;
    }
    $keys = array_values(array_unique($keys));
    sort($keys);

    foreach ($keys as $key) {
        $label = ucwords(strtolower(str_replace('_', ' ', $key)));
        $requirements[] = [
            'namespace' => $serviceName,
            'key' => $key,
            'label' => $label,
            'required' => false,
        ];
    }

    if ($requirements === []) {
        $requirements[] = ['namespace' => $serviceName, 'key' => 'SERVICE_URL', 'label' => 'Service URL', 'required' => false];
    }

    return $requirements;
}

function canonical_config_namespace(string $serviceName, string $namespace, string $key): string {
    $namespace = trim($namespace);
    return $namespace !== '' ? $namespace : trim($serviceName);
}

function normalize_runtime_config_values(array $configValues): array {
    $dbPath = trim((string)($configValues['JARVIS_INFRA_DB'] ?? ''));
    if ($dbPath !== '') $configValues['JARVIS_INFRA_DB'] = $dbPath;
    unset($configValues['JARVIS_INFRA_DB_DIR']);
    return $configValues;
}

function env_keys_from_python_file(string $path): array {
    $content = @file_get_contents($path);
    if (!is_string($content) || $content === '') return [];
    $keys = [];

    preg_match_all('/os\.getenv\(\s*[\'"]([A-Z0-9_]+)[\'"]/', $content, $m1);
    preg_match_all('/os\.environ\.get\(\s*[\'"]([A-Z0-9_]+)[\'"]/', $content, $m2);
    preg_match_all('/os\.environ\[\s*[\'"]([A-Z0-9_]+)[\'"]\s*\]/', $content, $m3);

    foreach ([$m1[1] ?? [], $m2[1] ?? [], $m3[1] ?? []] as $group) {
        foreach ($group as $k) $keys[] = (string)$k;
    }

    $keys = array_values(array_unique(array_filter($keys, static fn(string $k): bool => $k !== '')));
    sort($keys);
    return $keys;
}

function runtime_env_keys_for_tool(array $service): array {
    $toolDir = $service['tool_dir'] ?? null;
    if (!is_string($toolDir) || $toolDir === '' || !is_dir($toolDir)) return [];
    $keys = [];
    foreach (discover_python_paths($toolDir) as $path) {
        $keys = array_merge($keys, env_keys_from_python_file($path));
    }
    $keys = array_values(array_unique($keys));
    sort($keys);
    return $keys;
}

function config_namespaces_for_service(array $service): array {
    $namespaces = [];
    $serviceName = (string)($service['name'] ?? '');
    if ($serviceName !== '') $namespaces[] = $serviceName;
    foreach (($service['config_requirements'] ?? []) as $row) {
        if (is_array($row) && isset($row['namespace']) && is_string($row['namespace']) && trim($row['namespace']) !== '') {
            $namespaces[] = trim($row['namespace']);
        }
    }
    $namespaces = array_values(array_unique($namespaces));
    sort($namespaces);
    return $namespaces;
}



function service_operations_from_manifest(array $manifest): array {
    $ops = [];
    $properties = $manifest['input_schema']['properties'] ?? [];
    if (is_array($properties) && isset($properties['operation']['enum']) && is_array($properties['operation']['enum'])) {
        foreach ($properties['operation']['enum'] as $op) {
            if (is_string($op) && trim($op) !== '') $ops[] = trim($op);
        }
    }
    $ops = array_values(array_unique($ops));
    sort($ops);
    return $ops;
}

function list_services_full(): array {
    $services = [];
    foreach (discover_manifest_paths(tools_root()) as $manifestPath) {
        $manifest = json_decode(file_get_contents($manifestPath) ?: '{}', true);
        if (!is_array($manifest)) continue;

        $toolDir = dirname($manifestPath);
        $entrypoint = (string)($manifest['entrypoint'] ?? 'tool.py');
        $codeFiles = [];
        foreach (discover_python_paths($toolDir) as $py) {
            $codeFiles[] = ['path' => $py, 'filename' => basename($py)];
        }
        $runtimeEnvKeys = [];
        foreach ($codeFiles as $codeFile) {
            if (!is_array($codeFile) || !is_string($codeFile['path'] ?? null)) continue;
            $runtimeEnvKeys = array_merge($runtimeEnvKeys, env_keys_from_python_file($codeFile['path']));
        }
        $runtimeEnvKeys = array_values(array_unique($runtimeEnvKeys));
        sort($runtimeEnvKeys);

        $sampleInput = [];
        if (isset($manifest['input_schema']) && is_array($manifest['input_schema'])) {
            $sample = sample_from_schema($manifest['input_schema']);
            if (is_array($sample)) $sampleInput = $sample;
        }

        $configRequirements = [];
        if (isset($manifest['config_requirements']) && is_array($manifest['config_requirements'])) {
            foreach ($manifest['config_requirements'] as $row) {
                if (is_array($row) && isset($row['key'])) {
                    $configRequirements[] = [
                        'namespace' => (string)($row['namespace'] ?? ($manifest['name'] ?? basename($toolDir))),
                        'key' => (string)$row['key'],
                        'label' => (string)($row['label'] ?? $row['key']),
                        'required' => (bool)($row['required'] ?? false),
                    ];
                }
            }
        }
        if ($configRequirements === []) {
            $nameFallback = (string)($manifest['name'] ?? basename($toolDir));
            $configRequirements = inferred_config_requirements($nameFallback, $runtimeEnvKeys);
        }

        $services[] = [
            'name' => (string)($manifest['name'] ?? basename($toolDir)),
            'description' => (string)($manifest['description'] ?? ''),
            'engine_default' => (string)($manifest['runtime']['engine'] ?? 'python_direct'),
            'manifest_path' => $manifestPath,
            'tool_dir' => $toolDir,
            'entrypoint' => $entrypoint,
            'sample_input' => $sampleInput,
            'required_fields' => $manifest['input_schema']['required'] ?? [],
            'config_requirements' => $configRequirements,
            'code_files' => $codeFiles,
            'runtime_env_keys' => $runtimeEnvKeys,
            'operations' => service_operations_from_manifest($manifest),
        ];
    }

    if ($services === []) $services[] = default_demo_service();
    usort($services, static fn(array $a, array $b): int => strcmp($a['name'], $b['name']));
    return $services;
}

function find_service(string $name): ?array {
    foreach (list_services_full() as $service) {
        if (($service['name'] ?? '') === $name) return $service;
    }
    return null;
}

function load_service_config_values(PDO $pdo, string $serviceName, string $profile): array {
    $stmt = $pdo->prepare('SELECT config_key, config_value FROM service_config_values WHERE service_name = :service_name AND profile = :profile ORDER BY config_key');
    $stmt->execute([':service_name' => $serviceName, ':profile' => $profile]);
    $out = [];
    foreach ($stmt->fetchAll() as $row) $out[(string)$row['config_key']] = $row['config_value'];
    return $out;
}

function load_config_rows_by_namespaces(PDO $pdo, string $profile, array $namespaces): array {
    $clean = [];
    foreach ($namespaces as $ns) {
        if (is_string($ns) && trim($ns) !== '') $clean[] = trim($ns);
    }
    $clean = array_values(array_unique($clean));
    if ($clean === []) return [];
    $holders = implode(',', array_fill(0, count($clean), '?'));
    $sql = "SELECT profile, service_name, config_key, config_value, updated_at
            FROM service_config_values
            WHERE profile = ? AND service_name IN ($holders)
            ORDER BY service_name, config_key";
    $stmt = $pdo->prepare($sql);
    $stmt->execute(array_merge([$profile], $clean));
    return $stmt->fetchAll();
}

function resolve_service_config(array $service, PDO $pdo, string $profile): array {
    $serviceName = (string)($service['name'] ?? '');
    $requirements = is_array($service['config_requirements'] ?? null) ? $service['config_requirements'] : [];
    $namespaces = config_namespaces_for_service($service);
    $rows = load_config_rows_by_namespaces($pdo, $profile, $namespaces);

    $byNamespace = [];
    $allValues = [];
    foreach ($rows as $row) {
        $key = (string)$row['config_key'];
        $ns = canonical_config_namespace($serviceName, (string)$row['service_name'], $key);
        $key = (string)$row['config_key'];
        $val = $row['config_value'];
        if (!isset($byNamespace[$ns])) $byNamespace[$ns] = [];
        $byNamespace[$ns][$key] = $val;
        if (!array_key_exists($key, $allValues)) $allValues[$key] = $val;
    }

    $resolved = [];
    $entries = [];
    foreach ($requirements as $req) {
        if (!is_array($req) || !isset($req['key'])) continue;
        $key = (string)$req['key'];
        $ns = (string)($req['namespace'] ?? $serviceName);
        $value = $byNamespace[$ns][$key] ?? ($byNamespace[$serviceName][$key] ?? ($allValues[$key] ?? ''));
        $resolved[$key] = $value;
        $entries[] = ['namespace' => $ns, 'key' => $key, 'value' => $value];
    }

    foreach ($rows as $row) {
        $entries[] = [
            'namespace' => canonical_config_namespace($serviceName, (string)$row['service_name'], (string)$row['config_key']),
            'key' => (string)$row['config_key'],
            'value' => $row['config_value'],
        ];
    }
    $seen = [];
    $deduped = [];
    foreach ($entries as $entry) {
        $id = $entry['namespace'] . '|' . $entry['key'];
        if (isset($seen[$id])) continue;
        $seen[$id] = true;
        $deduped[] = $entry;
    }

    return [
        'values' => $resolved,
        'entries' => $deduped,
        'namespaces' => $namespaces,
        'rows' => $rows,
    ];
}

function save_service_config_values(PDO $pdo, string $serviceName, string $profile, array $config): void {
    $stmt = $pdo->prepare("
        INSERT INTO service_config_values(profile, service_name, config_key, config_value, updated_at)
        VALUES(:profile, :service_name, :config_key, :config_value, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(profile, service_name, config_key)
        DO UPDATE SET config_value = excluded.config_value, updated_at = excluded.updated_at
    ");
    foreach ($config as $key => $value) {
        $stmt->execute([
            ':profile' => $profile,
            ':service_name' => $serviceName,
            ':config_key' => (string)$key,
            ':config_value' => is_scalar($value) || $value === null ? (string)$value : json_encode($value, JSON_UNESCAPED_UNICODE),
        ]);
    }
}

function delete_service_config_value(PDO $pdo, string $profile, string $service, string $key): bool {
    $stmt = $pdo->prepare('DELETE FROM service_config_values WHERE profile = :profile AND service_name = :service AND config_key = :key');
    $stmt->execute([':profile' => $profile, ':service' => $service, ':key' => $key]);
    return $stmt->rowCount() > 0;
}

function list_all_config_rows(PDO $pdo): array {
    return $pdo->query('SELECT profile, service_name, config_key, config_value, updated_at FROM service_config_values ORDER BY profile, service_name, config_key')->fetchAll();
}

function list_table_names(PDO $pdo): array {
    $rows = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")->fetchAll();
    return array_map(static fn(array $r): string => (string)$r['name'], $rows);
}

function get_table_rows(PDO $pdo, string $table, int $limit = 100): array {
    if (!preg_match('/^[a-zA-Z0-9_]+$/', $table)) throw new RuntimeException('Nom de table invalide.');
    $columns = $pdo->query('PRAGMA table_info(' . $table . ')')->fetchAll();
    $stmt = $pdo->prepare('SELECT * FROM ' . $table . ' LIMIT :limit');
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->execute();
    return [
        'table' => $table,
        'columns' => array_map(static fn(array $c): string => (string)$c['name'], $columns),
        'rows' => $stmt->fetchAll(),
    ];
}

function is_allowed_code_path(string $path): bool {
    $real = realpath($path);
    if ($real === false || !is_file($real)) return false;
    $toolsRoot = realpath(tools_root());
    $selfRoot = realpath(__DIR__);
    if ($toolsRoot !== false && str_starts_with($real, $toolsRoot)) return true;
    if ($selfRoot !== false && str_starts_with($real, $selfRoot)) return true;
    return false;
}

function run_python_direct(array $service, array $payload, int $timeout, array $configValues = []): array {
    $entrypoint = $service['entrypoint'] ?? null;
    $toolDir = $service['tool_dir'] ?? null;
    if (!$entrypoint || !$toolDir) {
        return ['status' => 'error', 'summary' => 'Entrypoint introuvable.', 'stdout' => '', 'stderr' => 'Service sans entrypoint Python.', 'output' => null];
    }

    $script = $toolDir . DIRECTORY_SEPARATOR . $entrypoint;
    if (!is_file($script)) {
        return ['status' => 'error', 'summary' => 'Script introuvable.', 'stdout' => '', 'stderr' => 'Fichier absent: ' . $script, 'output' => null];
    }

    $cmd = ['python3', $script];
    $escaped = implode(' ', array_map('escapeshellarg', $cmd));
    $descriptor = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $env = [];
    foreach ($_SERVER as $k => $v) {
        if (is_string($k) && is_scalar($v)) $env[$k] = (string)$v;
    }
    foreach ($configValues as $k => $v) {
        if (is_string($k) && $k !== '' && is_scalar($v)) $env[$k] = (string)$v;
    }

    $process = proc_open($escaped, $descriptor, $pipes, $toolDir, $env);
    if (!is_resource($process)) {
        return ['status' => 'error', 'summary' => 'Impossible de lancer le process.', 'stdout' => '', 'stderr' => 'proc_open a échoué.', 'output' => null];
    }

    fwrite($pipes[0], json_encode($payload, JSON_UNESCAPED_UNICODE));
    fclose($pipes[0]);
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);

    $stdout = ''; $stderr = ''; $start = microtime(true); $timedOut = false;
    do {
        $status = proc_get_status($process);
        $stdout .= stream_get_contents($pipes[1]);
        $stderr .= stream_get_contents($pipes[2]);
        if (!$status['running']) break;
        if ((microtime(true) - $start) > $timeout) {
            proc_terminate($process);
            $timedOut = true;
            break;
        }
        usleep(100000);
    } while (true);

    $stdout .= stream_get_contents($pipes[1]);
    $stderr .= stream_get_contents($pipes[2]);
    fclose($pipes[1]); fclose($pipes[2]);
    $exitCode = proc_close($process);

    $decoded = null;
    $trimmed = trim($stdout);
    if ($trimmed !== '') {
        $tmp = json_decode($trimmed, true);
        if (json_last_error() === JSON_ERROR_NONE) $decoded = $tmp;
    }

    if ($timedOut) return ['status' => 'timeout', 'summary' => 'Temps limite dépassé.', 'stdout' => $stdout, 'stderr' => $stderr, 'output' => $decoded];
    return ['status' => $exitCode === 0 ? 'ok' : 'error', 'summary' => $exitCode === 0 ? 'Exécution terminée.' : 'Le process a renvoyé un code non nul.', 'stdout' => $stdout, 'stderr' => $stderr, 'output' => $decoded];
}

$payload = parse_payload();
if (isset($_GET['action']) && !isset($payload['action'])) $payload['action'] = (string)$_GET['action'];
if (isset($_GET['db_path']) && !isset($payload['db_path'])) $payload['db_path'] = (string)$_GET['db_path'];
$action = (string)($payload['action'] ?? '');
$activeDbPath = resolve_db_path($payload);

switch ($action) {
    case 'ping':
        json_response(['ok' => true, 'php_version' => PHP_VERSION, 'script_dir' => __DIR__]);

    case 'healthcheck':
        json_response([
            'ok' => true,
            'php_version' => PHP_VERSION,
            'cwd' => getcwd(),
            'script_dir' => __DIR__,
            'tools_root' => tools_root(),
            'tools_root_exists' => is_dir(tools_root()),
            'service_count' => count(list_services_full()),
            'db_probe' => safe_db_probe($activeDbPath),
            'pdo_sqlite_loaded' => extension_loaded('pdo_sqlite'),
            'sqlite3_loaded' => extension_loaded('sqlite3'),
            'preferred_db_path' => $activeDbPath,
        ]);

    case 'list_services':
        $items = [];
        foreach (list_services_full() as $service) {
            $items[] = [
                'name' => $service['name'],
                'description' => $service['description'],
                'engine_default' => $service['engine_default'],
                'config_requirements' => $service['config_requirements'] ?? [],
                'runtime_env_keys' => $service['runtime_env_keys'] ?? [],
                'operations' => $service['operations'] ?? [],
            ];
        }
        json_response(['ok' => true, 'services' => $items]);

    case 'get_service':
        $serviceName = (string)($payload['service'] ?? '');
        $profile = (string)($payload['profile'] ?? 'default');
        $service = find_service($serviceName);
        if (!$service) json_response(['error' => 'service_not_found', 'service' => $serviceName], 404);
        $service['profile'] = $profile;
        $resolvedConfig = resolve_service_config($service, pdo($activeDbPath), $profile);
        $runtimeEnvKeys = runtime_env_keys_for_tool($service);
        $service['config_values'] = $resolvedConfig['values'];
        $service['config_entries'] = $resolvedConfig['entries'];
        $service['config_namespaces'] = $resolvedConfig['namespaces'];
        $service['runtime_env_keys'] = $runtimeEnvKeys;
        $service['missing_runtime_env_keys'] = array_values(array_filter(
            $runtimeEnvKeys,
            static fn(string $k): bool => !array_key_exists($k, $resolvedConfig['values']) && !array_filter(
                $resolvedConfig['entries'],
                static fn(array $e): bool => ($e['key'] ?? '') === $k && trim((string)($e['value'] ?? '')) !== ''
            )
        ));
        json_response(['ok' => true, 'service' => $service]);

    case 'save_service_config':
        $serviceName = (string)($payload['service'] ?? '');
        $profile = (string)($payload['profile'] ?? 'default');
        $config = $payload['config'] ?? null;
        $entries = $payload['config_entries'] ?? null;
        if (!is_array($config) && !is_array($entries)) json_response(['error' => 'invalid_config'], 400);
        $service = find_service($serviceName);
        if (!$service) json_response(['error' => 'service_not_found', 'service' => $serviceName], 404);
        $pdoConn = pdo($activeDbPath);
        if (is_array($config)) save_service_config_values($pdoConn, $serviceName, $profile, $config);
        if (is_array($entries)) {
            foreach ($entries as $entry) {
                if (!is_array($entry)) continue;
                $rawNamespace = trim((string)($entry['namespace'] ?? $serviceName));
                $key = trim((string)($entry['key'] ?? ''));
                if ($key === '') continue;
                $namespace = canonical_config_namespace($serviceName, $rawNamespace, $key);
                if ($namespace === '') continue;
                save_service_config_values($pdoConn, $namespace, $profile, [$key => (string)($entry['value'] ?? '')]);
            }
        }
        json_response(['ok' => true, 'service' => $serviceName, 'profile' => $profile]);

    case 'run_service_test':
        $serviceName = (string)($payload['service'] ?? '');
        $engine = (string)($payload['engine'] ?? 'plan_only');
        $profile = (string)($payload['profile'] ?? 'default');
        $timeout = max(1, min(300, (int)($payload['timeout'] ?? 30)));
        $inputPayload = $payload['payload'] ?? [];
        if (!is_array($inputPayload)) json_response(['error' => 'payload_must_be_object_or_array'], 400);
        $service = find_service($serviceName);
        if (!$service) json_response(['error' => 'service_not_found', 'service' => $serviceName], 404);

        $configResolved = resolve_service_config($service, pdo($activeDbPath), $profile);
        $configValues = $configResolved['values'];
        foreach ($configResolved['entries'] as $entry) {
            if (!is_array($entry)) continue;
            $k = (string)($entry['key'] ?? '');
            $v = $entry['value'] ?? '';
            if ($k !== '' && !array_key_exists($k, $configValues)) $configValues[$k] = $v;
        }
        $configValues = normalize_runtime_config_values($configValues);
        $configValues['JARVIS_CONFIG_PROFILE'] = $profile;

        $startedAt = gmdate('c');
        $t0 = microtime(true);
        if ($engine === 'python_direct') {
            $exec = run_python_direct($service, $inputPayload, $timeout, $configValues);
        } else {
            $exec = [
                'status' => 'ok',
                'summary' => 'Mode plan_only: aucun moteur réel lancé.',
                'stdout' => '',
                'stderr' => '',
                'output' => [
                    'note' => 'plan_only',
                    'service' => $serviceName,
                    'payload' => $inputPayload,
                    'config_profile' => $profile,
                    'config_values' => $configValues,
                ],
            ];
        }
        $durationMs = (int)round((microtime(true) - $t0) * 1000);
        $endedAt = gmdate('c');

        $stmt = pdo($activeDbPath)->prepare("
            INSERT INTO devlab_runs(service_name, engine, profile, status, started_at, ended_at, duration_ms, summary, payload_json, output_json, stdout_text, stderr_text)
            VALUES(:service_name, :engine, :profile, :status, :started_at, :ended_at, :duration_ms, :summary, :payload_json, :output_json, :stdout_text, :stderr_text)
        ");
        $stmt->execute([
            ':service_name' => $serviceName,
            ':engine' => $engine,
            ':profile' => $profile,
            ':status' => $exec['status'],
            ':started_at' => $startedAt,
            ':ended_at' => $endedAt,
            ':duration_ms' => $durationMs,
            ':summary' => $exec['summary'],
            ':payload_json' => json_encode($inputPayload, JSON_UNESCAPED_UNICODE),
            ':output_json' => json_encode($exec['output'], JSON_UNESCAPED_UNICODE),
            ':stdout_text' => $exec['stdout'],
            ':stderr_text' => $exec['stderr'],
        ]);
        $runId = (int)pdo($activeDbPath)->lastInsertId();

        json_response([
            'ok' => true,
            'run_id' => $runId,
            'service' => $serviceName,
            'engine' => $engine,
            'profile' => $profile,
            'status' => $exec['status'],
            'started_at' => $startedAt,
            'ended_at' => $endedAt,
            'duration_ms' => $durationMs,
            'summary' => $exec['summary'],
            'stdout' => $exec['stdout'],
            'stderr' => $exec['stderr'],
            'output' => $exec['output'],
            'config_profile' => $profile,
            'config_values' => $configValues,
        ]);

    case 'list_runs':
        $serviceName = (string)($payload['service'] ?? '');
        if ($serviceName !== '') {
            $stmt = pdo($activeDbPath)->prepare('SELECT * FROM devlab_runs WHERE service_name = :service_name ORDER BY run_id DESC LIMIT 50');
            $stmt->execute([':service_name' => $serviceName]);
        } else {
            $stmt = pdo($activeDbPath)->query('SELECT * FROM devlab_runs ORDER BY run_id DESC LIMIT 50');
        }
        json_response(['ok' => true, 'runs' => $stmt->fetchAll()]);

    case 'list_service_code_files':
        $serviceName = (string)($payload['service'] ?? '');
        $service = find_service($serviceName);
        if (!$service) json_response(['error' => 'service_not_found', 'service' => $serviceName], 404);
        $files = $service['code_files'] ?? [];
        if (($service['manifest_path'] ?? null) && is_file($service['manifest_path'])) $files[] = ['path' => $service['manifest_path'], 'filename' => basename($service['manifest_path'])];
        json_response(['ok' => true, 'files' => $files]);

    case 'read_code_file':
        $path = (string)($payload['path'] ?? '');
        if ($path === '' || !is_allowed_code_path($path)) json_response(['error' => 'invalid_or_forbidden_path'], 403);
        json_response(['ok' => true, 'path' => realpath($path), 'content' => file_get_contents($path)]);

    case 'save_code_file':
        $path = (string)($payload['path'] ?? '');
        $content = (string)($payload['content'] ?? '');
        if ($path === '' || !is_allowed_code_path($path) || !is_writable($path)) json_response(['error' => 'invalid_or_unwritable_path'], 403);
        file_put_contents($path, $content);
        json_response(['ok' => true, 'path' => realpath($path), 'bytes' => strlen($content)]);

    case 'validate_code_file':
        $path = (string)($payload['path'] ?? '');
        $content = (string)($payload['content'] ?? '');
        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));

        if ($ext === 'json') {
            json_decode($content, true);
            $valid = json_last_error() === JSON_ERROR_NONE;
            json_response(['ok' => true, 'valid' => $valid, 'language' => 'json', 'message' => $valid ? 'JSON valide.' : json_last_error_msg()]);
        }

        if ($ext === 'py') {
            $tmp = tempnam(sys_get_temp_dir(), 'devlab_py_');
            file_put_contents($tmp, $content);
            $cmd = 'python3 -m py_compile ' . escapeshellarg($tmp) . ' 2>&1';
            $output = [];
            $exitCode = 0;
            exec($cmd, $output, $exitCode);
            @unlink($tmp);
            json_response(['ok' => true, 'valid' => $exitCode === 0, 'language' => 'python', 'message' => $exitCode === 0 ? 'Python valide.' : implode("\n", $output)]);
        }

        json_response(['ok' => true, 'valid' => true, 'language' => $ext ?: 'text', 'message' => 'Validation non spécifique, considérée comme OK.']);


    case 'browse_paths':
        $path = (string)($payload['path'] ?? dirname($activeDbPath));
        json_response(['ok' => true] + browse_db_paths($path));

    case 'create_db':
        $path = normalize_db_candidate((string)($payload['path'] ?? ''));
        if (!path_in_allowed_roots($path)) json_response(['error' => 'path_not_allowed'], 403);
        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        if (!in_array($ext, ['db', 'sqlite', 'sqlite3'], true)) json_response(['error' => 'invalid_extension'], 400);
        $dir = dirname($path);
        if (!ensure_dir($dir)) json_response(['error' => 'dir_not_writable'], 400);
        pdo($path);
        json_response(['ok' => true, 'path' => $path, 'created' => file_exists($path)]);

    case 'delete_db':
        $path = normalize_db_candidate((string)($payload['path'] ?? ''));
        if (!path_in_allowed_roots($path)) json_response(['error' => 'path_not_allowed'], 403);
        if (!is_file($path)) json_response(['error' => 'db_not_found'], 404);
        if (!@unlink($path)) json_response(['error' => 'delete_failed'], 500);
        json_response(['ok' => true, 'deleted' => true, 'path' => $path]);

    case 'download_db':
        $path = $activeDbPath;
        if (!is_file($path)) json_response(['error' => 'db_not_found', 'path' => $path], 404);
        header_remove('Content-Type');
        header('Content-Type: application/octet-stream');
        header('Content-Disposition: attachment; filename="' . basename($path) . '"');
        readfile($path);
        exit;

    case 'db_list_tables':
        json_response(['ok' => true, 'tables' => list_table_names(pdo($activeDbPath))]);

    case 'db_get_table':
        $table = (string)($payload['table'] ?? 'service_config_values');
        $limit = max(1, min(500, (int)($payload['limit'] ?? 100)));
        json_response(['ok' => true] + get_table_rows(pdo($activeDbPath), $table, $limit));

    case 'db_list_config':
        json_response(['ok' => true, 'rows' => list_all_config_rows(pdo($activeDbPath))]);

    case 'debug_db_access':
        $paths = $payload['paths'] ?? [];
        $candidateList = [];
        if (is_array($paths)) {
            foreach ($paths as $candidate) {
                if (!is_string($candidate)) continue;
                $trimmed = trim($candidate);
                if ($trimmed !== '') $candidateList[] = $trimmed;
            }
        }
        if (!$candidateList) $candidateList = [$activeDbPath];
        $candidateList = array_values(array_unique($candidateList));

        $inspections = [];
        foreach ($candidateList as $candidate) {
            try {
                $inspections[] = inspect_db_path($candidate);
            } catch (Throwable $e) {
                $inspections[] = ['path' => $candidate, 'error' => $e->getMessage()];
            }
        }
        json_response([
            'ok' => true,
            'active_db_path' => $activeDbPath,
            'php_user' => function_exists('get_current_user') ? get_current_user() : null,
            'inspections' => $inspections,
        ]);

    case 'db_set_config':
        $profile = trim((string)($payload['profile'] ?? 'default'));
        $service = trim((string)($payload['service'] ?? ''));
        $key = trim((string)($payload['key'] ?? ''));
        $value = (string)($payload['value'] ?? '');
        if ($service === '' || $key === '') json_response(['error' => 'service_and_key_required'], 400);
        save_service_config_values(pdo($activeDbPath), $service, $profile, [$key => $value]);
        json_response(['ok' => true, 'profile' => $profile, 'service' => $service, 'key' => $key]);

    case 'db_delete_config':
        $profile = trim((string)($payload['profile'] ?? 'default'));
        $service = trim((string)($payload['service'] ?? ''));
        $key = trim((string)($payload['key'] ?? ''));
        if ($service === '' || $key === '') json_response(['error' => 'service_and_key_required'], 400);
        $deleted = delete_service_config_value(pdo($activeDbPath), $profile, $service, $key);
        json_response(['ok' => true, 'deleted' => $deleted]);

    default:
        json_response(['error' => 'unknown_action', 'action' => $action], 400);
}
