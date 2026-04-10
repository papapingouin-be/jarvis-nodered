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

    return $pdo;
}

try {
    $payload = json_decode(file_get_contents('php://input') ?: '{}', true, flags: JSON_THROW_ON_ERROR);
    $action = $payload['action'] ?? null;
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
            $stmt = $pdo->prepare('SELECT namespace, key, updated_at FROM sensitive_values WHERE namespace = :namespace ORDER BY key');
            $stmt->execute([':namespace' => as_string($payload, 'namespace')]);
            echo json_encode(['items' => $stmt->fetchAll()]);
            break;

        case 'upsert_proxmox_target':
            $row = $payload['row'] ?? [];
            if (!is_array($row)) {
                fail('row invalide');
            }
            $password = $row['password'] ?? null;
            $secret = $row['password_secret_key'] ?? null;
            if (($password === null || $password === '') === ($secret === null || $secret === '')) {
                fail('proxmox target: fournir password OU password_secret_key');
            }
            $stmt = $pdo->prepare("INSERT INTO proxmox_targets(name, ip, api_path, login, password, password_secret_key, node)
                VALUES(:name, :ip, :api_path, :login, :password, :password_secret_key, :node)
                ON CONFLICT(name) DO UPDATE SET
                    ip=excluded.ip,
                    api_path=excluded.api_path,
                    login=excluded.login,
                    password=excluded.password,
                    password_secret_key=excluded.password_secret_key,
                    node=excluded.node");
            $stmt->execute([
                ':name' => as_string($row, 'name'),
                ':ip' => as_string($row, 'ip'),
                ':api_path' => as_string($row, 'api_path') ?? '/api2/json',
                ':login' => as_string($row, 'login'),
                ':password' => $password ?: null,
                ':password_secret_key' => $secret ?: null,
                ':node' => as_string($row, 'node'),
            ]);
            echo json_encode(['ok' => true]);
            break;

        case 'list_proxmox_targets':
            echo json_encode(['items' => $pdo->query('SELECT name, ip, api_path, login, node, password_secret_key FROM proxmox_targets ORDER BY name')->fetchAll()]);
            break;

        case 'upsert_ct_service':
            $row = $payload['row'] ?? [];
            if (!is_array($row)) {
                fail('row invalide');
            }
            $stmt = $pdo->prepare("INSERT INTO ct_services(name, target_name, ctid, path)
                VALUES(:name, :target_name, :ctid, :path)
                ON CONFLICT(name) DO UPDATE SET
                    target_name=excluded.target_name,
                    ctid=excluded.ctid,
                    path=excluded.path");
            $stmt->execute([
                ':name' => as_string($row, 'name'),
                ':target_name' => as_string($row, 'target_name'),
                ':ctid' => (int)($row['ctid'] ?? 0),
                ':path' => as_string($row, 'path', false) ?: '/',
            ]);
            echo json_encode(['ok' => true]);
            break;

        case 'list_ct_services':
            echo json_encode(['items' => $pdo->query('SELECT name, target_name, ctid, path FROM ct_services ORDER BY name')->fetchAll()]);
            break;

        case 'upsert_npm_instance':
            $row = $payload['row'] ?? [];
            if (!is_array($row)) {
                fail('row invalide');
            }
            $password = $row['password'] ?? null;
            $secret = $row['password_secret_key'] ?? null;
            if (($password === null || $password === '') === ($secret === null || $secret === '')) {
                fail('npm instance: fournir password OU password_secret_key');
            }
            $stmt = $pdo->prepare("INSERT INTO npm_instances(name, base_url, login, password, password_secret_key)
                VALUES(:name, :base_url, :login, :password, :password_secret_key)
                ON CONFLICT(name) DO UPDATE SET
                    base_url=excluded.base_url,
                    login=excluded.login,
                    password=excluded.password,
                    password_secret_key=excluded.password_secret_key");
            $stmt->execute([
                ':name' => as_string($row, 'name'),
                ':base_url' => as_string($row, 'base_url'),
                ':login' => as_string($row, 'login'),
                ':password' => $password ?: null,
                ':password_secret_key' => $secret ?: null,
            ]);
            echo json_encode(['ok' => true]);
            break;

        case 'list_npm_instances':
            echo json_encode(['items' => $pdo->query('SELECT name, base_url, login, password_secret_key FROM npm_instances ORDER BY name')->fetchAll()]);
            break;

        case 'upsert_npm_service':
            $row = $payload['row'] ?? [];
            if (!is_array($row)) {
                fail('row invalide');
            }
            $stmt = $pdo->prepare("INSERT INTO npm_services(domain, instance_name, forward_host, forward_port, scheme)
                VALUES(:domain, :instance_name, :forward_host, :forward_port, :scheme)
                ON CONFLICT(domain) DO UPDATE SET
                    instance_name=excluded.instance_name,
                    forward_host=excluded.forward_host,
                    forward_port=excluded.forward_port,
                    scheme=excluded.scheme");
            $stmt->execute([
                ':domain' => as_string($row, 'domain'),
                ':instance_name' => as_string($row, 'instance_name'),
                ':forward_host' => as_string($row, 'forward_host'),
                ':forward_port' => (int)($row['forward_port'] ?? 0),
                ':scheme' => as_string($row, 'scheme', false) ?: 'http',
            ]);
            echo json_encode(['ok' => true]);
            break;

        case 'list_npm_services':
            $stmt = $pdo->prepare('SELECT domain, instance_name, forward_host, forward_port, scheme FROM npm_services WHERE instance_name = :instance_name ORDER BY domain');
            $stmt->execute([':instance_name' => as_string($payload, 'instance_name')]);
            echo json_encode(['items' => $stmt->fetchAll()]);
            break;

        default:
            fail("action inconnue: {$action}");
    }
} catch (JsonException $e) {
    fail('JSON invalide: ' . $e->getMessage());
} catch (Throwable $e) {
    fail($e->getMessage(), 500);
}
