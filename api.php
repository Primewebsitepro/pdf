<?php
/**
 * Stock Portal - PHP backend for shared hosting (e.g. Hostinger Premium).
 * No database needed: data is stored as JSON files in ./data (blocked from the web by data/.htaccess).
 *
 * Public:  GET  api.php?action=info | stock | settings      POST action=request
 * Admin:   POST action=setup | login | logout | save_stock | undo | save_settings | password
 *          GET  action=requests | history                    POST action=request_update | request_delete
 */
declare(strict_types=1);

const DATA_DIR = __DIR__ . '/data';
const SEED_DIR = __DIR__ . '/stock'; // initial stock/settings shipped with the site

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

// ---------- storage ----------
if (!is_dir(DATA_DIR . '/backups')) { @mkdir(DATA_DIR . '/backups', 0755, true); }
if (!file_exists(DATA_DIR . '/.htaccess')) {
    @file_put_contents(DATA_DIR . '/.htaccess', "Require all denied\nDeny from all\n");
}
if (!file_exists(DATA_DIR . '/index.html')) { @file_put_contents(DATA_DIR . '/index.html', ''); }

function read_json(string $name, $fallback) {
    $f = DATA_DIR . '/' . $name;
    if (!is_file($f)) return $fallback;
    $d = json_decode((string) file_get_contents($f), true);
    return $d === null ? $fallback : $d;
}
function write_json(string $name, $value): void {
    $f = DATA_DIR . '/' . $name;
    $tmp = $f . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (file_put_contents($tmp, json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX) === false) {
        fail('Could not save data. Check that the "data" folder is writable.', 500);
    }
    rename($tmp, $f);
}
function seed(string $name, $fallback) {
    $d = read_json($name, null);
    if ($d !== null) return $d;
    $s = SEED_DIR . '/' . $name;
    if (is_file($s)) { $d = json_decode((string) file_get_contents($s), true); if ($d !== null) return $d; }
    return $fallback;
}

// ---------- helpers ----------
function out($data, int $code = 200): void { http_response_code($code); echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); exit; }
function fail(string $msg, int $code = 400): void { out(['error' => $msg], $code); }
function body(): array {
    $raw = file_get_contents('php://input');
    $d = json_decode($raw ?: '{}', true);
    return is_array($d) ? $d : [];
}
function clip($v, int $n): string {
    $s = trim((string) ($v ?? ''));
    return function_exists('mb_substr') ? mb_substr($s, 0, $n) : substr($s, 0, $n);
}
function client_ip(): string { return (string) ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'] ?? ''); }
function limited(string $key, int $max, int $seconds): bool {
    $all = read_json('ratelimit.json', []);
    $now = time();
    foreach ($all as $k => $times) { $all[$k] = array_values(array_filter($times, fn($t) => $now - $t < 3600)); if (!$all[$k]) unset($all[$k]); }
    $times = array_values(array_filter($all[$key] ?? [], fn($t) => $now - $t < $seconds));
    $times[] = $now;
    $all[$key] = $times;
    write_json('ratelimit.json', $all);
    return count($times) > $max;
}

// ---------- session ----------
$https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
session_name('stockadmin');
session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'httponly' => true, 'samesite' => 'Lax', 'secure' => $https]);
session_start();
function is_admin(): bool { return !empty($_SESSION['admin']) && ($_SESSION['exp'] ?? 0) > time(); }
function require_admin(): void { if (!is_admin()) fail('Please log in', 401); }
function login_ok(): void { session_regenerate_id(true); $_SESSION['admin'] = true; $_SESSION['exp'] = time() + 12 * 3600; }

$action = (string) ($_GET['action'] ?? '');
$method = $_SERVER['REQUEST_METHOD'];

// CSRF protection: every POST must come from our own pages.
if ($method === 'POST') {
    if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'stockportal') fail('Forbidden', 403);
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin && parse_url($origin, PHP_URL_HOST) !== parse_url('http://' . ($_SERVER['HTTP_HOST'] ?? ''), PHP_URL_HOST)) fail('Forbidden', 403);
}

$DEFAULT_SETTINGS = [
    'siteName' => 'Meghavi Distributors', 'contactPhone' => '+91 99743 43448',
    'address' => '', 'gst' => '', 'stockDisplay' => 'qty', 'lowStockLimit' => 5, 'showOutOfStock' => true,
];

switch ("$method $action") {
    // ===== public =====
    case 'GET info':
        $cfg = read_json('config.json', []);
        out(['mode' => 'php', 'setupNeeded' => empty($cfg['adminHash']), 'loggedIn' => is_admin()]);

    case 'GET stock':
        out(seed('stock.json', ['version' => 0, 'asOf' => '', 'updatedAt' => null, 'fields' => [], 'items' => []]));

    case 'GET settings':
        out(array_merge($DEFAULT_SETTINGS, seed('settings.json', [])));

    case 'POST request':
        if (limited('req:' . client_ip(), 20, 600)) fail('Too many requests sent. Please wait a few minutes.', 429);
        $b = body();
        $r = [
            'id' => bin2hex(random_bytes(8)), 'at' => gmdate('c'),
            'type' => in_array($b['type'] ?? '', ['order', 'new', 'other'], true) ? $b['type'] : 'other',
            'product' => clip($b['product'] ?? '', 200), 'qty' => clip($b['qty'] ?? '', 40),
            'shop' => clip($b['shop'] ?? '', 120), 'phone' => clip($b['phone'] ?? '', 20),
            'message' => clip($b['message'] ?? '', 1000), 'status' => 'new',
        ];
        if ($r['shop'] === '' || $r['phone'] === '' || ($r['product'] === '' && $r['message'] === '')) fail('Please fill shop name, mobile number and product / message.');
        // Optional product photo (sent as a data URL, already resized in the browser).
        $photo = (string) ($b['photo'] ?? '');
        if ($photo !== '') {
            if (!preg_match('#^data:image/(jpeg|png|webp);base64,#', $photo, $pm)) fail('The photo must be an image.');
            $bin = base64_decode(substr($photo, strpos($photo, ',') + 1), true);
            if ($bin === false || strlen($bin) > 5 * 1024 * 1024) fail('The photo is too large.');
            if (function_exists('getimagesizefromstring') && @getimagesizefromstring($bin) === false) fail('The photo could not be read.');
            if (!is_dir(DATA_DIR . '/photos')) @mkdir(DATA_DIR . '/photos', 0755, true);
            $ext = $pm[1] === 'jpeg' ? 'jpg' : $pm[1];
            if (file_put_contents(DATA_DIR . '/photos/' . $r['id'] . '.' . $ext, $bin) === false) fail('Could not save the photo.', 500);
            $r['photo'] = $ext;
        }
        $all = read_json('requests.json', []);
        array_unshift($all, $r);
        write_json('requests.json', array_slice($all, 0, 5000));
        // Reply to the retailer first, then email the business (so the retailer never waits for email).
        http_response_code(200);
        echo json_encode(['ok' => true]);
        if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
        elseif (function_exists('litespeed_finish_request')) litespeed_finish_request();
        else flush();
        ignore_user_abort(true);
        require_once __DIR__ . '/lib/mailer.php';
        send_request_email($r, $bin ?? null, $ext ?? 'jpg');
        exit;

    // ===== admin auth =====
    case 'POST setup':
        $cfg = read_json('config.json', []);
        if (!empty($cfg['adminHash'])) fail('Already set up');
        $pw = (string) (body()['password'] ?? '');
        if (strlen($pw) < 8) fail('Password must be at least 8 characters');
        $cfg['adminHash'] = password_hash($pw, PASSWORD_DEFAULT);
        write_json('config.json', $cfg);
        login_ok();
        out(['ok' => true]);

    case 'POST login':
        if (limited('login:' . client_ip(), 8, 900)) fail('Too many attempts. Try again in 15 minutes.', 429);
        $cfg = read_json('config.json', []);
        if (empty($cfg['adminHash']) || !password_verify((string) (body()['password'] ?? ''), $cfg['adminHash'])) fail('Wrong password', 401);
        login_ok();
        out(['ok' => true]);

    case 'POST logout':
        $_SESSION = [];
        session_destroy();
        out(['ok' => true]);

    case 'POST password':
        require_admin();
        $b = body();
        $cfg = read_json('config.json', []);
        if (!password_verify((string) ($b['current'] ?? ''), $cfg['adminHash'] ?? '')) fail('Current password is wrong', 401);
        if (strlen((string) ($b['password'] ?? '')) < 8) fail('New password must be at least 8 characters');
        $cfg['adminHash'] = password_hash((string) $b['password'], PASSWORD_DEFAULT);
        write_json('config.json', $cfg);
        out(['ok' => true]);

    // ===== admin data =====
    case 'POST save_stock':
        require_admin();
        $new = body();
        if (empty($new['fields']) || !isset($new['items']) || !is_array($new['items'])) fail('Invalid stock data');
        $old = seed('stock.json', null);
        if ($old) {
            write_json('backups/stock-' . time() . '-' . bin2hex(random_bytes(2)) . '.json', $old);
            $list = glob(DATA_DIR . '/backups/stock-*.json') ?: [];
            sort($list);
            while (count($list) > 20) { @unlink(array_shift($list)); }
        }
        $new['version'] = (int) (($old['version'] ?? 0)) + 1;
        $new['updatedAt'] = gmdate('c');
        write_json('stock.json', $new);
        $log = read_json('uploads.json', []);
        array_unshift($log, ['at' => $new['updatedAt'], 'message' => clip($_GET['message'] ?? ('Stock as on ' . ($new['asOf'] ?? '-')), 300)]);
        write_json('uploads.json', array_slice($log, 0, 200));
        out(['ok' => true, 'version' => $new['version']]);

    case 'POST undo':
        require_admin();
        $list = glob(DATA_DIR . '/backups/stock-*.json') ?: [];
        sort($list);
        if (!$list) fail('There is no earlier stock to restore.');
        $file = array_pop($list);
        $prev = json_decode((string) file_get_contents($file), true);
        $cur = seed('stock.json', ['version' => 0]);
        $prev['version'] = (int) ($cur['version'] ?? 0) + 1;
        write_json('stock.json', $prev);
        @unlink($file);
        $log = read_json('uploads.json', []);
        array_unshift($log, ['at' => gmdate('c'), 'message' => 'Restored previous stock (as on ' . ($prev['asOf'] ?? '-') . ')']);
        write_json('uploads.json', array_slice($log, 0, 200));
        out(['ok' => true, 'version' => $prev['version']]);

    case 'GET history':
        require_admin();
        $list = glob(DATA_DIR . '/backups/stock-*.json') ?: [];
        out(['items' => read_json('uploads.json', []), 'canUndo' => count($list) > 0]);

    case 'POST save_settings':
        require_admin();
        $b = body();
        $s = [
            'siteName' => clip($b['siteName'] ?? '', 100) ?: 'Stock',
            'contactPhone' => preg_replace('/[^\d+ ]/', '', clip($b['contactPhone'] ?? '', 20)),
            'address' => clip($b['address'] ?? '', 300), 'gst' => strtoupper(clip($b['gst'] ?? '', 20)),
            'stockDisplay' => ($b['stockDisplay'] ?? '') === 'status' ? 'status' : 'qty',
            'lowStockLimit' => max(0, min(100000, (int) ($b['lowStockLimit'] ?? 5))),
            'showOutOfStock' => !empty($b['showOutOfStock']),
        ];
        write_json('settings.json', $s);
        out(['ok' => true, 'settings' => $s]);

    case 'GET photo':
        require_admin();
        $pid = preg_replace('/[^a-f0-9]/', '', (string) ($_GET['id'] ?? ''));
        foreach (['jpg' => 'image/jpeg', 'png' => 'image/png', 'webp' => 'image/webp'] as $ext => $mime) {
            $f = DATA_DIR . '/photos/' . $pid . '.' . $ext;
            if ($pid !== '' && is_file($f)) { header('Content-Type: ' . $mime); header('Cache-Control: private, max-age=86400'); readfile($f); exit; }
        }
        fail('Not found', 404);

    case 'GET requests':
        require_admin();
        out(['items' => read_json('requests.json', [])]);

    case 'POST request_update':
    case 'POST request_delete':
        require_admin();
        $b = body();
        $all = read_json('requests.json', []);
        $i = null;
        foreach ($all as $k => $r) { if (($r['id'] ?? '') === ($b['id'] ?? null)) { $i = $k; break; } }
        if ($i === null) fail('Not found', 404);
        if ($action === 'request_delete') {
            foreach (['jpg', 'png', 'webp'] as $ext) { @unlink(DATA_DIR . '/photos/' . preg_replace('/[^a-f0-9]/', '', (string) $all[$i]['id']) . '.' . $ext); }
            array_splice($all, $i, 1);
        }
        elseif (in_array($b['status'] ?? '', ['new', 'seen', 'done'], true)) $all[$i]['status'] = $b['status'];
        write_json('requests.json', array_values($all));
        out(['ok' => true]);

    default:
        fail('Not found', 404);
}
