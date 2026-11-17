# Stock Portal: retailer stock search and admin panel

A website where your retail shops can search your stock on their phones, and send an
order or a new-product request. The admin uploads the stock Excel every day.

## On PHP hosting (MilesWeb / Hostinger / any cPanel): recommended

The same files run on normal shared hosting, using `api.php`. You do not need Node.js or a database.

What you get on PHP hosting:
- Admin login with a normal password.
- Requests are saved on the website, and the admin sees them in a **Requests** tab, with Call, WhatsApp, Mark done and CSV download.
- Upload and Undo work instantly.
- Data is stored in `data/`, which is blocked from the web.

How to put it on the hosting:
1. Log in to **cPanel**. In **Select PHP Version**, choose PHP 8.1 or newer (8.2 is fine).
2. Open **File Manager → public_html**.
   - If WordPress is already installed there, create a folder such as `stock` instead. The website will then open at `yourdomain.com/stock/`.
3. **Upload** `website-upload.zip`, right-click it and choose **Extract**.
4. Open `yourdomain.com/admin.html` (or `/stock/admin.html`) and **set the admin password**. Do this immediately.
5. Turn on free SSL: cPanel → **SSL/TLS Status → Run AutoSSL**.
6. Every day: Admin → Upload stock → choose the Excel → **Publish**.

The upload zip contains these files:
- `index.html`, `admin.html`, `api.php`, `.htaccess`
- `public/` (style.css, search.js, app.js)
- `lib/`
- `static/`
- `stock/`

## Email alerts for new orders (PHP hosting)

When a retailer submits an Order or Request, `api.php` saves it and emails the business. The email includes the product photo, if one was added.

To set this up, copy `mail-config.example.php` to `mail-config.php` on the server and fill in the SMTP details:
- the mailbox used only for **sending**
- its password
- the address that **receives** the emails

Replies go to the receiving address, never to the sending mailbox. `mail-config.php` is in `.gitignore`, and `.htaccess` blocks it from the web. **Never commit it.** If sending fails, the reason is written to `data/mail.log`.

## Live website (GitHub Pages)

- Retailer website: https://primewebsitepro.github.io/pdf/
- Admin: https://primewebsitepro.github.io/pdf/admin.html

The GitHub Pages version needs no server. Everything runs in the browser:
- Stock is read from `stock/stock.json`, and settings from `stock/settings.json`.
- Search and PDF downloads work fully on the phone.
- **Order / Request product** opens WhatsApp with the request already written, sent to the contact number in Settings.
- **Admin login** uses a GitHub fine-grained token with *Contents: Read and write* for this repository. The admin page explains how to create one.
- Uploading an Excel file shows a preview first. **Publish** saves `stock/stock.json` to this repository, and the website updates in about 1 minute.
- **Undo last upload** restores the previous version from the Git history.
- Commits made from the admin page use the GitHub no-reply address, never a personal email.

Things the GitHub Pages version cannot do, because there is no server:
- A secret retailer access code.
- Storing requests on the website. Requests arrive on WhatsApp instead.

The stock data is public to anyone who has the link. For those two features, run the Node.js server version described below.

Command-line alternative for updating stock: `node tools/build-stock-json.js "StockBtc.xlsx"`, then commit `stock/stock.json`.

## Node.js server version (optional)

The same website also runs as a Node.js app (`server.js`) on a VPS or Render. That version adds:
- server-side requests with an admin inbox
- a retailer access code
- password login

## Features (as per requirements)

| Requirement | How it works |
|---|---|
| Admin login and dashboard | `/admin`. On first open you set a password. Dashboard shows products, total stock, out-of-stock, low stock, new requests and upload history |
| Daily stock upload from Excel/CSV | Admin → **Upload stock** → choose the file. The billing-software export (`StockBtc ….xlsx`) works directly, no editing needed. A plain Excel/CSV with columns `ItemName, Stock, Mrp` (optional `Group, Company, Item Code`) also works |
| Existing stock updates automatically | Each upload **replaces** the old stock. The screen shows how many products are new, changed or removed. **Undo last upload** brings back the previous stock if a wrong file was uploaded |
| Searchable stock page for retailers | Main link `/`. Retailers open the link, type, and see results immediately. The stock list refreshes on its own within 3 minutes of each new upload |
| Search by product name and item code | Name, item code, group/salt and company are all searched |
| Partial search (middle or last letters) | `prost` finds MISOPROST and PROSTAGARD. `gard` finds PROSTAGARD. `dolo650` finds DOLO 650 |
| Basic typo-tolerant search | `carboprost` finds CERBOPROST, `agumentin` finds AUGMENTIN, `zerodl` finds ZERODOL. Words of 4–7 letters allow 1 mistake; words of 8+ letters allow 2 |
| Product request form | Each product has an **Order** button. When a search finds nothing, a **Request this product** button appears. A **+ Request product** button is always available. Admin sees the requests with Call, WhatsApp and Mark done buttons, and can download them as CSV for Excel |
| PDF download | Retailer page has a **Full stock PDF** button. After a search or filter it changes to **PDF (this list)** and downloads only what is on screen. The PDF is company-wise like the original report, with page numbers, and its text is searchable (Ctrl+F) on phones too. Admin → Products has **Download PDF (full qty)**, which always shows exact quantities, and **Retailer PDF** |
| iPhone and Android design | Tested at mobile width. Large text, a 16px+ search box (iPhone does not zoom), no sideways scrolling, and dark mode |
| Many users at the same time | Search runs on the phone itself, so the server only sends the stock list once per update (about 65 KB, compressed). In testing, 300 users were served in 0.2 seconds. A basic server can handle hundreds of retailers |

Extra options (Admin → Settings):
- **Retailer access code:** if you set a code, only shops that know it can see the stock. Changing the code logs out everyone.
- **Show stock as:** exact quantity, or only *In stock / Low / Out of stock*.
- **Contact mobile:** shown on the page with Call and WhatsApp links.
- Show or hide out-of-stock items.

## How the Excel file is read

- The company name row, `Total for:` rows, blank rows and the heading rows are handled automatically.
- If the same item with the same MRP appears on more than one row (different batches), the quantities are **added together**. The same item with a different MRP is shown separately.
- Scheme text such as `BURNOL CREAM 25 GM      5+1` is shown separately as **Scheme 5+1**.
- Items with negative stock are shown as "Out of stock".
- The broken `#NAME?` cell in the export (a Group value starting with "-") is recovered correctly.
- After every upload the file's **grand total is checked** against the imported total, and a warning is shown if they differ.
- Old `.xls` files are not supported. Save them as `.xlsx` or `.csv`.
- Your current export **has no item code column**. Code search starts working once the billing software adds an `Item Code` column to the export.

## Daily process (admin)

1. Export the stock Excel from the billing software (once or twice a day).
2. Open `https://your-site/admin`, then **Upload stock**, and choose the file.
3. Done. Retailers see the new stock automatically. If something looks wrong, click **Undo last upload**.

## Running it on your computer (for testing)

You need Node.js 18 or newer (already installed on this computer). Double-click `START.bat`, or run:

```
node server.js
```
- Retailer page: http://localhost:3000
- Admin: http://localhost:3000/admin

No `npm install` is needed. The project uses no external packages.

Tests: `node test/run-tests.js` (uses the `StockBtc meghavi -1.xlsx` file in the folder above).

## Putting it online (hosting)

This is a Node.js app, so you need hosting that supports Node.js. Plain PHP-only shared hosting will not work. Options:
- **A VPS** (Hostinger KVM, DigitalOcean or similar, about ₹400–800/month). This is recommended: it is fully under your control and handles many users.
- **Hostinger Business/Cloud** plans with Node.js support, Railway, or Render (with a persistent disk).

Settings:
- `PORT`: the port (default 3000).
- `DATA_DIR`: where the data is stored (default `./data`). **This folder must be on a permanent disk.**
- Always use **HTTPS** (a free SSL certificate from Let's Encrypt or Cloudflare), especially for the admin password.

On a VPS: `node server.js` behind Nginx with SSL, kept running with `pm2` or a systemd service.

## Where the data is stored

The `data/` folder holds:
- `stock.json`: the current stock
- `requests.json`: retailer requests
- `uploads.json`: upload history
- `settings.json`: settings
- `config.json`: the admin password (encrypted hash) and the secret key
- `backups/`: the last 20 stock files

Back up the `data/` folder from time to time. **Forgot the admin password?** Stop the server, delete the `adminHash` line from `data/config.json`, start the server again, and open `/admin` to set a new password.

## Files

```
server.js            web server + all APIs
lib/xlsx.js          Excel (.xlsx) and CSV reader (no external library)
lib/importer.js      converts the stock report into a clean product list
lib/pdf.js           PDF builder for the stock list (no external library)
lib/store.js         saves data to JSON files (safely, with backups)
public/index.html    retailer page   (app.js, style.css)
public/admin.html    admin panel     (admin.js)
public/search.js     search engine (partial + typo-tolerant)
test/run-tests.js    end-to-end tests
```
