<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');

function logdb(string $msg, $data = null): void {
    error_log('[DB] ' . $msg . ' ' . json_encode($data, JSON_UNESCAPED_UNICODE));
}

function fail(string $message, int $status = 400, array $extra = []): never {
    http_response_code($status);
    echo json_encode(array_merge(['error' => $message], $extra), JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}

function respond(array $data): never {
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}

function repo_root(): string {
    return dirname(__DIR__);
}

function preferred_db_path(): string {
    return '/var/www/jarvis/database/jarvis_infra.db';
}

function default_db_path(): string {
    return preferred_db_path();
}

function parse_payload(): array {
    $contentType = (string)($_SERVER['CONTENT_TYPE'] ?? '');
    if (str_contains($contentType, 'application/json')) {
        $raw = file_get_contents('php://input') ?: '{}';
        try {
            $decoded = json_decode($raw, true, flags: JSON_THROW_ON_ERROR);
            return is_array($decoded) ? $decoded : [];
        } catch (Throwable $e) {
            fail('JSON invalide: ' . $e->getMessage(), 400);
        }
    }
    return $_POST;
}

function current_db_path(array $payload): string {
    $path = trim((string)($payload['db_path'] ?? ($_GET['db_path'] ?? '')));
    if ($path !== '') return $path;
    $env = trim((string)(getenv('JARVIS_INFRA_DB') ?: ''));
    if ($env !== '') return $env;
    return default_db_path();
}

function db_health(string $path): array {
    $exists = is_file($path);
    $dir = dirname($path);
    $dirExists = is_dir($dir);
    $sqliteOpenOk = false;
    $sqliteError = null;
    if ($exists && is_readable($path)) {
        try {
            $pdo = new PDO('sqlite:' . $path);
            $pdo->query('SELECT 1');
            $sqliteOpenOk = true;
        } catch (Throwable $e) {
            $sqliteError = $e->getMessage();
        }
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
    ];
}

function allowed_roots(): array {
    return array_values(array_unique(array_filter([
        '/var/www',
        repo_root(),
        dirname(repo_root()),
    ], static fn($v) => is_string($v) && $v !== '')));
}

function is_allowed_path(string $path): bool {
    foreach (allowed_roots() as $root) {
        if ($path === $root || str_starts_with($path, rtrim($root, '/') . '/')) {
            return true;
        }
    }
    return false;
}

function normalize_existing_dir(string $path): string {
    $real = realpath($path);
    if ($real === false || !is_dir($real)) {
        fail('dossier introuvable: ' . $path, 404);
    }
    if (!is_allowed_path($real)) {
        fail('dossier hors périmètre autorisé', 403, ['path' => $real, 'allowed_roots' => allowed_roots()]);
    }
    return $real;
}

function normalize_target_file(string $path): string {
    $path = trim($path);
    if ($path === '') {
        fail('chemin fichier requis');
    }
    $absolute = str_starts_with($path, '/') ? $path : repo_root() . '/' . $path;
    $parent = dirname($absolute);
    $realParent = realpath($parent);
    if ($realParent === false || !is_dir($realParent)) {
        fail('dossier parent introuvable', 400, ['parent' => $parent]);
    }
    if (!is_allowed_path($realParent)) {
        fail('dossier parent hors périmètre autorisé', 403, ['parent' => $realParent, 'allowed_roots' => allowed_roots()]);
    }
    $basename = basename($absolute);
    if (!preg_match('/\.db$/i', $basename)) {
        fail('le fichier doit se terminer par .db', 400);
    }
    return rtrim($realParent, '/') . '/' . $basename;
}

function browse_paths(string $path): array {
    $dir = normalize_existing_dir($path);
    $entries = scandir($dir);
    if ($entries === false) {
        fail('impossible de lire le dossier', 500);
    }
    $items = [];
    foreach ($entries as $entry) {
        if ($entry === '.') continue;
        $full = $dir . DIRECTORY_SEPARATOR . $entry;
        if ($entry === '..') {
            $parent = dirname($dir);
            if ($parent !== $dir && is_allowed_path($parent)) {
                $items[] = ['name' => '..', 'path' => $parent, 'type' => 'dir'];
            }
            continue;
        }
        $real = realpath($full);
        if ($real === false || !is_allowed_path($real)) continue;
        if (is_dir($real)) {
            $items[] = ['name' => $entry, 'path' => $real, 'type' => 'dir'];
            continue;
        }
        if (preg_match('/\.(db|sqlite|sqlite3)$/i', $entry)) {
            $items[] = ['name' => $entry, 'path' => $real, 'type' => 'file', 'size' => filesize($real) ?: 0];
        }
    }
    usort($items, static function(array $a, array $b): int {
        if ($a['type'] !== $b['type']) return $a['type'] === 'dir' ? -1 : 1;
        return strcmp((string)$a['name'], (string)$b['name']);
    });
    return ['current_path' => $dir, 'items' => $items, 'allowed_roots' => allowed_roots()];
}

function ensure_schema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS sensitive_values (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY(namespace, key)
    )");
}

function create_db_at(string $targetPath): array {
    $target = normalize_target_file($targetPath);
    logdb('create.request', ['target' => $target]);
    if (is_file($target)) {
        return ['ok' => true, 'path' => $target, 'message' => 'db already exists', 'db' => db_health($target)];
    }
    $dir = dirname($target);
    if (!is_dir($dir) || !is_writable($dir)) {
        fail('dossier parent non accessible en écriture', 400, ['dir' => $dir]);
    }
    try {
        $pdo = new PDO('sqlite:' . $target);
        ensure_schema($pdo);
        $pdo = null;
    } catch (Throwable $e) {
        fail($e->getMessage(), 500, ['path' => $target]);
    }
    $health = db_health($target);
    logdb('create.done', ['target' => $target, 'health' => $health]);
    return ['ok' => true, 'path' => $target, 'db' => $health];
}

function delete_db_at(string $targetPath): array {
    $target = normalize_target_file($targetPath);
    logdb('delete.request', ['target' => $target]);
    if (!is_file($target)) fail('db introuvable', 404, ['path' => $target]);
    if (!unlink($target)) fail('suppression impossible', 500, ['path' => $target]);
    logdb('delete.done', ['target' => $target]);
    return ['ok' => true, 'deleted' => $target];
}

$payload = parse_payload();
$action = (string)($payload['action'] ?? ($_GET['action'] ?? 'healthcheck'));
$activePath = current_db_path($payload);
logdb('action', ['action' => $action, 'active_path' => $activePath]);

switch ($action) {
    case 'healthcheck':
        respond([
            'ok' => true,
            'db' => db_health($activePath),
            'preferred_db_path' => preferred_db_path(),
            'default_db_path' => default_db_path(),
            'allowed_roots' => allowed_roots(),
        ]);
    case 'browse_paths':
        $path = trim((string)($payload['path'] ?? preferred_db_path()));
        if ($path === '' || is_file($path)) $path = dirname($path !== '' ? $path : preferred_db_path());
        respond(['ok' => true] + browse_paths($path));
    case 'create_db':
        respond(create_db_at((string)($payload['path'] ?? '')));
    case 'delete_db':
        respond(delete_db_at((string)($payload['path'] ?? '')));
    case 'download_db':
        $target = normalize_target_file($activePath);
        logdb('download.request', ['target' => $target]);
        if (!is_file($target)) fail('db not found', 404, ['path' => $target]);
        header_remove('Content-Type');
        header('Content-Type: application/octet-stream');
        header('Content-Disposition: attachment; filename="' . basename($target) . '"');
        readfile($target);
        exit;
    default:
        fail('unknown action', 400, ['action' => $action]);
}
?>