# Fraud Detection Bank — DBMS Dashboard

A live admin dashboard for your `fraud_detection_bank` MySQL database.  
Shows real-time table data, live query logs, schema, execution flows, and a transfer money panel.

---

## Project Structure

```
fraud-dashboard/
├── backend/
│   ├── server.js       ← Express API (connects to MySQL)
│   ├── .env            ← Your DB credentials (edit this)
│   └── package.json
└── frontend/
    └── index.html      ← Open this in a browser
```

---

## Setup

### 1. Configure your database credentials

Edit `backend/.env`:

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=yourpassword
DB_NAME=fraud_detection_bank
PORT=3001
```

If you're using a remote MySQL host (e.g. freesqldatabase.com):
```env
DB_HOST=sql12.freesqldatabase.com
DB_USER=sql12xxxxxx
DB_PASSWORD=xxxxxxxx
DB_NAME=sql12xxxxxx
```

### 2. Install dependencies & start the backend

```bash
cd backend
npm install
node server.js
```

You should see: `Fraud Detection API running on http://localhost:3001`

### 3. Open the frontend

Just open `frontend/index.html` in your browser — no build step needed.

Make sure the API URL in the topbar matches where your server is running (default: `http://localhost:3001`).

---

## Features

| Tab | What it shows |
|-----|--------------|
| Overview | Stats, high-risk accounts, recent fraud alerts, audit log |
| Query Log | Every SQL query the dashboard makes, live. Includes custom executor (Ctrl+Enter to run) |
| Tables | All 6 tables: Users, Accounts, Transactions, Fraud_Alerts, Audit_Log, Risk_Score_History |
| Schema | Column types, PK/FK from information_schema, stored procedures + triggers |
| Exec Viz | Step-by-step trace: transfer_money procedure, detect_high_amount trigger, audit trigger |
| Transfer | Execute `CALL transfer_money(sender, receiver, amount)` live |

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/ping | Test DB connection |
| GET | /api/stats | Row counts for all tables |
| GET | /api/table/:name | Full table data (max 200 rows) |
| GET | /api/schema | Column types + FK info from information_schema |
| GET | /api/routines | Stored procedures + triggers |
| GET | /api/high-risk | Accounts with risk_score > 50 |
| GET | /api/fraud/rapid-txn | Rapid transaction detection query |
| POST | /api/query | Run any SELECT/SHOW/DESCRIBE/EXPLAIN |
| POST | /api/transfer | CALL transfer_money(sender, receiver, amount) |

---

## Notes

- The query executor only allows `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN` for safety.
- All write operations (transfer money) go through the stored procedure.
- Triggers (audit + fraud detection) fire automatically in MySQL — dashboard reflects results after refresh.
