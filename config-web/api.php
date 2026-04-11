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

function list_python_tools(): array {
    $tools = [];
    $manifestPaths = glob(tools_root() . '/*/manifest.json') ?: [];
    sort($manifestPaths);

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
        $schema = $manifest['input_schema']['properties'] ?? [];
        if (is_array($schema)) {
            foreach ($schema as $key => $meta) {
                if (!is_string($key) || !is_array($meta)) {
                    continue;
                }
                if (array_key_exists('default', $meta)) {
                    $sampleInput[$key] = $meta['default'];
                    continue;
                }
                $type = $meta['type'] ?? null;
                if ($type === 'string') {
                    $sampleInput[$key] = '';
                } elseif ($type === 'number' || $type === 'integer') {
                    $sampleInput[$key] = 0;
                } elseif ($type === 'boolean') {
                    $sampleInput[$key] = false;
                } elseif ($type === 'array') {
                    $sampleInput[$key] = [];
                } elseif ($type === 'object') {
                    $sampleInput[$key] = new stdClass();
                } else {
                    $sampleInput[$key] = null;
                }
            }
        }

        $tools[] = [
            'name' => $toolName,
            'entrypoint' => $entrypoint,
            'manifest_path' => str_replace(repo_root() . '/', '', $manifestPath),
            'code_path' => str_replace(repo_root() . '/', '', $toolCodePath),
            'sample_input' => $sampleInput,
        ];
    }

    return $tools;
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
            echo json_encode(['ok' => true, 'items' => list_python_tools()]);
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

        default:
            fail("action inconnue: {$action}");
    }
} catch (JsonException $e) {
    fail('JSON invalide: ' . $e->getMessage());
} catch (Throwable $e) {
    fail($e->getMessage(), 500);
}
