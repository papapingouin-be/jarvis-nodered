<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

function fail(string $message, int $status = 400): never {
    http_response_code($status);
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $payload = json_decode(file_get_contents('php://input') ?: '{}', true, flags: JSON_THROW_ON_ERROR);
    $path = (string)($payload['path'] ?? '/health');
    $method = strtoupper((string)($payload['method'] ?? 'POST'));
    $body = $payload['body'] ?? null;
    $query = $payload['query'] ?? [];
    $baseUrl = rtrim(getenv('DEVLAB_BACKEND_URL') ?: 'http://devlab_backend:8090', '/');

    if (!str_starts_with($path, '/')) {
        $path = '/' . $path;
    }
    if (is_array($query) && count($query) > 0) {
        $path .= '?' . http_build_query($query);
    }

    error_log('[devproxy] request ' . json_encode([
        'method' => $method,
        'path' => $path,
        'base_url' => $baseUrl,
    ], JSON_UNESCAPED_UNICODE));

    $ch = curl_init($baseUrl . $path);
    if ($ch === false) {
        fail("impossible d'initialiser cURL", 500);
    }

    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
    curl_setopt($ch, CURLOPT_TIMEOUT, 120);
    if ($method !== 'GET' && $body !== null) {
        $json = json_encode($body, JSON_UNESCAPED_UNICODE);
        if ($json === false) {
            fail('impossible de sérialiser le body JSON', 500);
        }
        curl_setopt($ch, CURLOPT_POSTFIELDS, $json);
    }

    $raw = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);

    if ($raw === false) {
        error_log('[devproxy] curl_error ' . json_encode([
            'base_url' => $baseUrl,
            'path' => $path,
            'method' => $method,
            'error' => $err,
        ], JSON_UNESCAPED_UNICODE));
        fail('backend devlab indisponible: ' . $err, 502);
    }

    error_log('[devproxy] response ' . json_encode([
        'code' => $code,
        'raw_prefix' => substr((string)$raw, 0, 500),
    ], JSON_UNESCAPED_UNICODE));

    http_response_code($code > 0 ? $code : 200);
    echo $raw;
} catch (JsonException $e) {
    fail('JSON invalide: ' . $e->getMessage());
} catch (Throwable $e) {
    error_log('[devproxy] exception ' . $e->getMessage());
    fail($e->getMessage(), 500);
}
