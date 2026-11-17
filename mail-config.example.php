<?php
// Copy this file to mail-config.php on the server and fill in the password.
// mail-config.php is private: it is excluded from Git (.gitignore) and blocked by .htaccess.
return [
    'enabled'        => true,
    'host'           => 'mail.example.com',      // SMTP server
    'fallback_hosts' => ['localhost'],           // tried if the main host fails (same server)
    'port'           => 465,                     // 465 = SSL, 587 = STARTTLS
    'secure'         => 'ssl',                   // 'ssl' or 'tls'
    'username'       => 'sender@example.com',    // mailbox used only to SEND
    'password'       => 'CHANGE-ME',
    'from_name'      => 'Stock Website',
    'to'             => 'owner@example.com',     // where new order/request emails are delivered
];
