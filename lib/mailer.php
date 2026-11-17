<?php
/**
 * Minimal SMTP mailer (no libraries). Sends the "new request" email to the business.
 * Settings come from mail-config.php (kept private, never committed to Git).
 */
declare(strict_types=1);

function mail_config(): ?array {
    $f = __DIR__ . '/../mail-config.php';
    if (!is_file($f)) return null;
    $c = include $f;
    return (is_array($c) && !empty($c['enabled'])) ? $c : null;
}

function mail_log(string $msg): void {
    $dir = __DIR__ . '/../data';
    if (is_dir($dir)) @file_put_contents($dir . '/mail.log', gmdate('c') . ' ' . $msg . "\n", FILE_APPEND | LOCK_EX);
}

function smtp_read($fp): string {
    $data = '';
    while (($line = fgets($fp, 515)) !== false) {
        $data .= $line;
        if (strlen($line) < 4 || $line[3] === ' ') break;
    }
    return $data;
}
function smtp_cmd($fp, string $cmd, array $okCodes): string {
    if ($cmd !== '') fwrite($fp, $cmd . "\r\n");
    $resp = smtp_read($fp);
    if (!in_array((int) substr($resp, 0, 3), $okCodes, true)) {
        // Never log credentials: only show the SMTP verb (e.g. "MAIL", "RCPT"), not its data.
        $shown = preg_match('/^(EHLO|AUTH LOGIN|MAIL|RCPT|DATA|STARTTLS|QUIT)/', $cmd, $mm) ? $mm[1] : ($cmd === '' ? 'response' : 'credentials');
        throw new RuntimeException('SMTP error after ' . $shown . ': ' . trim($resp));
    }
    return $resp;
}

/** Try each host until one works. Returns true when the server accepted the message. */
function smtp_send(array $c, string $to, string $rawMessage): bool {
    $hosts = array_values(array_unique(array_filter(array_merge([$c['host'] ?? ''], $c['fallback_hosts'] ?? []))));
    $port = (int) ($c['port'] ?? 465);
    $secure = $c['secure'] ?? 'ssl';
    $lastError = '';
    foreach ($hosts as $i => $host) {
        // The main host is verified normally; fallback hosts (same server) may use a certificate for another name.
        $verify = $i === 0;
        $ctx = stream_context_create(['ssl' => ['verify_peer' => $verify, 'verify_peer_name' => $verify, 'allow_self_signed' => !$verify]]);
        $target = ($secure === 'ssl' ? 'ssl://' : 'tcp://') . $host . ':' . $port;
        $fp = @stream_socket_client($target, $errno, $errstr, 12, STREAM_CLIENT_CONNECT, $ctx);
        if (!$fp) { $lastError = "$host: $errstr ($errno)"; continue; }
        stream_set_timeout($fp, 20);
        try {
            smtp_cmd($fp, '', [220]);
            $ehlo = 'EHLO ' . (preg_replace('/[^a-z0-9.-]/i', '', (string) ($_SERVER['HTTP_HOST'] ?? 'localhost')) ?: 'localhost');
            smtp_cmd($fp, $ehlo, [250]);
            if ($secure === 'tls') {
                smtp_cmd($fp, 'STARTTLS', [220]);
                if (!stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) throw new RuntimeException('STARTTLS failed');
                smtp_cmd($fp, $ehlo, [250]);
            }
            smtp_cmd($fp, 'AUTH LOGIN', [334]);
            smtp_cmd($fp, base64_encode($c['username']), [334]);
            smtp_cmd($fp, base64_encode($c['password']), [235]);
            smtp_cmd($fp, 'MAIL FROM:<' . $c['username'] . '>', [250]);
            smtp_cmd($fp, 'RCPT TO:<' . $to . '>', [250, 251]);
            smtp_cmd($fp, 'DATA', [354]);
            // Dot-stuffing: lines starting with "." get an extra "."
            $body = preg_replace('/^\./m', '..', str_replace(["\r\n", "\r"], "\n", $rawMessage));
            fwrite($fp, str_replace("\n", "\r\n", $body) . "\r\n.\r\n");
            smtp_cmd($fp, '', [250]);
            @fwrite($fp, "QUIT\r\n");
            fclose($fp);
            return true;
        } catch (Throwable $e) {
            $lastError = "$host: " . $e->getMessage();
            @fclose($fp);
        }
    }
    mail_log('SMTP failed: ' . $lastError);
    return false;
}

function mime_header(string $s): string { return '=?UTF-8?B?' . base64_encode($s) . '?='; }

/** Email the business about a new retailer request. Never throws. */
function send_request_email(array $r, ?string $photoBin = null, string $photoExt = 'jpg'): void {
    try {
        $c = mail_config();
        if (!$c) return;
        $to = $c['to'];
        $types = ['order' => 'ORDER', 'new' => 'NEW PRODUCT REQUEST', 'other' => 'REQUEST'];
        $type = $types[$r['type'] ?? ''] ?? 'REQUEST';
        $subject = $type . ': ' . ($r['product'] !== '' ? $r['product'] : 'Message') . ' — ' . $r['shop'];
        if (function_exists('mb_substr')) $subject = mb_substr($subject, 0, 150);

        $ist = new DateTime('now', new DateTimeZone('Asia/Kolkata'));
        $lines = [
            'New request from the stock website',
            '',
            'Type:     ' . $type,
            'Product:  ' . ($r['product'] !== '' ? $r['product'] : '-'),
            'Quantity: ' . ($r['qty'] !== '' ? $r['qty'] : '-'),
            'Shop:     ' . $r['shop'],
            'Mobile:   ' . $r['phone'],
            'Message:  ' . ($r['message'] !== '' ? $r['message'] : '-'),
            'Time:     ' . $ist->format('d M Y, h:i A') . ' (IST)',
        ];
        $digits = preg_replace('/\D/', '', $r['phone']);
        if ($digits !== '') {
            $lines[] = '';
            $lines[] = 'Call:     tel:' . $r['phone'];
            $lines[] = 'WhatsApp: https://wa.me/' . (strlen($digits) === 10 ? '91' . $digits : $digits);
        }
        if ($photoBin !== null) { $lines[] = ''; $lines[] = 'Product photo attached.'; }
        $text = implode("\n", $lines) . "\n";

        $fromName = $c['from_name'] ?? 'Stock Website';
        $boundary = 'b' . bin2hex(random_bytes(8));
        $host = explode('@', $c['username'])[1] ?? 'localhost';
        $headers = [
            'From: ' . mime_header($fromName) . ' <' . $c['username'] . '>',
            'To: <' . $to . '>',
            // Replies go to the business inbox, never to the sending address.
            'Reply-To: <' . $to . '>',
            'Subject: ' . mime_header($subject),
            'Date: ' . date('r'),
            'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . $host . '>',
            'MIME-Version: 1.0',
        ];
        if ($photoBin === null) {
            $headers[] = 'Content-Type: text/plain; charset=UTF-8';
            $headers[] = 'Content-Transfer-Encoding: base64';
            $msg = implode("\n", $headers) . "\n\n" . chunk_split(base64_encode($text), 76, "\n");
        } else {
            $mime = ['jpg' => 'image/jpeg', 'png' => 'image/png', 'webp' => 'image/webp'][$photoExt] ?? 'image/jpeg';
            $headers[] = 'Content-Type: multipart/mixed; boundary="' . $boundary . '"';
            $msg = implode("\n", $headers) . "\n\n"
                . "--$boundary\nContent-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: base64\n\n"
                . chunk_split(base64_encode($text), 76, "\n")
                . "--$boundary\nContent-Type: $mime; name=\"product-photo.$photoExt\"\nContent-Transfer-Encoding: base64\nContent-Disposition: attachment; filename=\"product-photo.$photoExt\"\n\n"
                . chunk_split(base64_encode($photoBin), 76, "\n")
                . "--$boundary--\n";
        }
        if (smtp_send($c, $to, $msg)) return;

        // Fallback: the hosting server's own mail() function.
        $parts = explode("\n\n", $msg, 2);
        $hdr = preg_replace('/^(To|Subject):.*\n/m', '', $parts[0] . "\n");
        $ok = @mail($to, mime_header($subject), $parts[1] ?? '', trim(str_replace("\n", "\r\n", $hdr)), '-f' . $c['username']);
        if (!$ok) mail_log('mail() fallback also failed');
    } catch (Throwable $e) {
        mail_log('Email error: ' . $e->getMessage());
    }
}
