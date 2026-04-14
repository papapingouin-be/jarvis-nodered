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
        if (ensure_dir($dir)) return rtrim($dir, '/') . '/devlab.db';
    }
    throw new RuntimeException('Aucun dossier inscriptible pour la DB SQLite.');
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

function pdo(): PDO {
    static $pdo = null;
    if ($pdo instanceof PDO) return $pdo;
    $pdo = new PDO('sqlite:' . db_path());
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('PRAGMA foreign_keys = ON');
    ensure_schema($pdo);
    return $pdo;
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
    $raw = file_get_contents('php://input') ?: '{}';
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) json_response(['error' => 'invalid_json'], 400);
    return $decoded;
}

function safe_db_probe(): array {
    try {
        $path = db_path();
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

function inferred_config_requirements(string $serviceName): array {
    $map = [
        'npm_service' => [
            ['namespace' => 'npm_service', 'key' => 'JARVIS_INFRA_DB', 'label' => 'Chemin DB infra', 'required' => false],
            ['namespace' => 'npm_service', 'key' => 'NPM_URL', 'label' => 'NPM URL', 'required' => false],
            ['namespace' => 'npm_service', 'key' => 'NPM_IDENTITY', 'label' => 'NPM Identity', 'required' => false],
            ['namespace' => 'npm_service', 'key' => 'NPM_SECRET', 'label' => 'NPM Secret', 'required' => false],
        ],
        'proxmox_ct' => [
            ['namespace' => 'proxmox_ct', 'key' => 'JARVIS_INFRA_DB', 'label' => 'Chemin DB infra', 'required' => false],
            ['namespace' => 'proxmox', 'key' => 'PROXMOX_HOST', 'label' => 'Proxmox host', 'required' => false],
            ['namespace' => 'proxmox', 'key' => 'PROXMOX_USER', 'label' => 'Proxmox user', 'required' => false],
            ['namespace' => 'proxmox', 'key' => 'PROXMOX_PASSWORD', 'label' => 'Proxmox password', 'required' => false],
        ],
        'sensitive_store' => [
            ['namespace' => 'sensitive_store', 'key' => 'JARVIS_INFRA_DB', 'label' => 'Chemin DB infra', 'required' => false],
        ],
    ];
    return $map[$serviceName] ?? [];
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
            $configRequirements = inferred_config_requirements($nameFallback);
            if ($configRequirements === []) {
                $configRequirements = [
                    ['namespace' => $nameFallback, 'key' => 'SERVICE_URL', 'label' => 'Service URL', 'required' => false],
                ];
            }
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
$action = (string)($payload['action'] ?? '');

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
            'db_probe' => safe_db_probe(),
            'pdo_sqlite_loaded' => extension_loaded('pdo_sqlite'),
            'sqlite3_loaded' => extension_loaded('sqlite3'),
        ]);

    case 'list_services':
        $items = [];
        foreach (list_services_full() as $service) {
            $items[] = ['name' => $service['name'], 'description' => $service['description'], 'engine_default' => $service['engine_default']];
        }
        json_response(['ok' => true, 'services' => $items]);

    case 'get_service':
        $serviceName = (string)($payload['service'] ?? '');
        $profile = (string)($payload['profile'] ?? 'default');
        $service = find_service($serviceName);
        if (!$service) json_response(['error' => 'service_not_found', 'service' => $serviceName], 404);
        $service['profile'] = $profile;
        $service['config_values'] = load_service_config_values(pdo(), $serviceName, $profile);
        json_response(['ok' => true, 'service' => $service]);

    case 'save_service_config':
        $serviceName = (string)($payload['service'] ?? '');
        $profile = (string)($payload['profile'] ?? 'default');
        $config = $payload['config'] ?? null;
        if (!is_array($config)) json_response(['error' => 'invalid_config'], 400);
        $service = find_service($serviceName);
        if (!$service) json_response(['error' => 'service_not_found', 'service' => $serviceName], 404);
        save_service_config_values(pdo(), $serviceName, $profile, $config);
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

        $configValues = load_service_config_values(pdo(), $serviceName, $profile);
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

        $stmt = pdo()->prepare("
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
        $runId = (int)pdo()->lastInsertId();

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
            $stmt = pdo()->prepare('SELECT * FROM devlab_runs WHERE service_name = :service_name ORDER BY run_id DESC LIMIT 50');
            $stmt->execute([':service_name' => $serviceName]);
        } else {
            $stmt = pdo()->query('SELECT * FROM devlab_runs ORDER BY run_id DESC LIMIT 50');
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

    case 'db_list_tables':
        json_response(['ok' => true, 'tables' => list_table_names(pdo())]);

    case 'db_get_table':
        $table = (string)($payload['table'] ?? 'service_config_values');
        $limit = max(1, min(500, (int)($payload['limit'] ?? 100)));
        json_response(['ok' => true] + get_table_rows(pdo(), $table, $limit));

    case 'db_list_config':
        json_response(['ok' => true, 'rows' => list_all_config_rows(pdo())]);

    case 'db_set_config':
        $profile = trim((string)($payload['profile'] ?? 'default'));
        $service = trim((string)($payload['service'] ?? ''));
        $key = trim((string)($payload['key'] ?? ''));
        $value = (string)($payload['value'] ?? '');
        if ($service === '' || $key === '') json_response(['error' => 'service_and_key_required'], 400);
        save_service_config_values(pdo(), $service, $profile, [$key => $value]);
        json_response(['ok' => true, 'profile' => $profile, 'service' => $service, 'key' => $key]);

    case 'db_delete_config':
        $profile = trim((string)($payload['profile'] ?? 'default'));
        $service = trim((string)($payload['service'] ?? ''));
        $key = trim((string)($payload['key'] ?? ''));
        if ($service === '' || $key === '') json_response(['error' => 'service_and_key_required'], 400);
        $deleted = delete_service_config_value(pdo(), $profile, $service, $key);
        json_response(['ok' => true, 'deleted' => $deleted]);

    default:
        json_response(['error' => 'unknown_action', 'action' => $action], 400);
}
