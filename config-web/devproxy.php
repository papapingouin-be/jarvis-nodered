<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

function fail(string $message, int $status = 400, array $extra = []): never {
    http_response_code($status);
    echo json_encode(array_merge(['error' => $message], $extra), JSON_UNESCAPED_UNICODE);
    exit;
}

function normalize_base_candidates(?string $requestedBase): array {
    $candidates = [];
    $push = static function (?string $value) use (&$candidates): void {
        $value = trim((string)$value);
        if ($value === '') {
            return;
        }
        $candidates[] = rtrim($value, '/');
    };

    $push($requestedBase);
    $push(getenv('DEVLAB_BACKEND_URL') ?: '');
    $push('http://devlab_backend:8090');
    $push('http://127.0.0.1:8090');
    $push('http://host.docker.internal:8090');

    if (!empty($_SERVER['HTTP_HOST'])) {
        $host = preg_replace('/:\d+$/', '', (string)$_SERVER['HTTP_HOST']);
        if ($host) {
            $push('http://' . $host . ':8090');
            $push('https://' . $host . ':8090');
        }
    }

    return array_values(array_unique($candidates));
}

try {
    $payload = json_decode(file_get_contents('php://input') ?: '{}', true, flags: JSON_THROW_ON_ERROR);
    $path = (string)($payload['path'] ?? '/health');
    $method = strtoupper((string)($payload['method'] ?? 'POST'));
    $body = $payload['body'] ?? null;
    $query = is_array($payload['query'] ?? null) ? $payload['query'] : [];
    $requestedBase = isset($payload['base_url']) ? (string)$payload['base_url'] : null;

    if (!str_starts_with($path, '/')) {
        $path = '/' . $path;
    }
    if ($query !== []) {
        $path .= '?' . http_build_query($query);
    }

    $bases = normalize_base_candidates($requestedBase);
    if ($bases === []) {
        fail('aucune URL backend disponible pour le proxy devlab', 500);
    }

    $errors = [];
    foreach ($bases as $baseUrl) {
        error_log('[devproxy] trying ' . json_encode([
            'method' => $method,
            'path' => $path,
            'base_url' => $baseUrl,
        ], JSON_UNESCAPED_UNICODE));

        $ch = curl_init($baseUrl . $path);
        if ($ch === false) {
            $errors[] = ['base_url' => $baseUrl, 'error' => "impossible d'initialiser cURL"];
            continue;
        }

        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
        curl_setopt($ch, CURLOPT_TIMEOUT, 25);
        if ($method !== 'GET' && $body !== null) {
            $json = json_encode($body, JSON_UNESCAPED_UNICODE);
            if ($json === false) {
                curl_close($ch);
                fail('impossible de sérialiser le body JSON', 500);
            }
            curl_setopt($ch, CURLOPT_POSTFIELDS, $json);
        }

        $raw = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);

        if ($raw === false) {
            $errors[] = ['base_url' => $baseUrl, 'error' => $err ?: 'erreur inconnue'];
            error_log('[devproxy] curl_error ' . json_encode(end($errors), JSON_UNESCAPED_UNICODE));
            continue;
        }

        error_log('[devproxy] response ' . json_encode([
            'base_url' => $baseUrl,
            'code' => $code,
            'raw_prefix' => substr((string)$raw, 0, 400),
        ], JSON_UNESCAPED_UNICODE));

        http_response_code($code > 0 ? $code : 200);
        echo $raw;
        exit;
    }

    fail('backend devlab indisponible', 502, [
        'path' => $path,
        'requested_base_url' => $requestedBase,
        'tried_base_urls' => $bases,
        'errors' => $errors,
        'hint' => 'Mets DEVLAB_BACKEND_URL ou saisis proxy:http://IP:8090 dans le champ URL Dev backend.',
    ]);
} catch (JsonException $e) {
    fail('JSON invalide: ' . $e->getMessage());
} catch (Throwable $e) {
    error_log('[devproxy] exception ' . $e->getMessage());
    fail($e->getMessage(), 500);
}
