require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Serve frontend from backend — no cross-origin issues
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'fraud_detection_bank',
  waitForConnections: true,
  connectionLimit: 10,
};

let pool;

async function getPool() {
  if (!pool) pool = mysql.createPool(dbConfig);
  return pool;
}

async function query(sql, params = []) {
  const p = await getPool();
  const [rows, fields] = await p.execute(sql, params);
  return { rows, fields };
}

// Test connection
app.get('/api/ping', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, db: dbConfig.database, host: dbConfig.host });
  } catch (e) {
    console.error('DB connection error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Execute arbitrary SELECT query (safe — no DDL/DML from UI)
app.post('/api/query', async (req, res) => {
  const { sql } = req.body;
  if (!sql) return res.status(400).json({ error: 'No SQL provided' });
  const upper = sql.trim().toUpperCase();
  const allowed = ['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN'];
  if (!allowed.some(k => upper.startsWith(k))) {
    return res.status(403).json({ error: 'Only SELECT/SHOW/DESCRIBE/EXPLAIN allowed from UI' });
  }
  try {
    const start = Date.now();
    const { rows, fields } = await query(sql);
    const ms = Date.now() - start;
    const columns = fields ? fields.map(f => f.name) : [];
    res.json({ rows, columns, ms, rowCount: rows.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Stats summary
app.get('/api/stats', async (req, res) => {
  try {
    const tables = ['Users', 'Accounts', 'Transactions', 'Fraud_Alerts', 'Audit_Log', 'Risk_Score_History'];
    const counts = {};
    for (const t of tables) {
      const { rows } = await query(`SELECT COUNT(*) as cnt FROM \`${t}\``);
      counts[t] = rows[0].cnt;
    }
    res.json(counts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get full table data
app.get('/api/table/:name', async (req, res) => {
  const allowed = ['Users', 'Accounts', 'Transactions', 'Fraud_Alerts', 'Audit_Log', 'Risk_Score_History'];
  const name = req.params.name;
  if (!allowed.includes(name)) return res.status(403).json({ error: 'Table not allowed' });
  try {
    const { rows, fields } = await query(`SELECT * FROM \`${name}\` ORDER BY 1 DESC LIMIT 200`);
    const columns = fields ? fields.map(f => f.name) : [];
    res.json({ rows, columns });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Schema info
app.get('/api/schema', async (req, res) => {
  try {
    const { rows: tables } = await query(
      `SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
      [dbConfig.database]
    );
    const schema = {};
    for (const t of tables) {
      const { rows: cols } = await query(
        `SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [dbConfig.database, t.TABLE_NAME]
      );
      const { rows: fks } = await query(
        `SELECT COLUMN_NAME, REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [dbConfig.database, t.TABLE_NAME]
      );
      const fkMap = {};
      fks.forEach(f => { fkMap[f.COLUMN_NAME] = f.REFERENCED_TABLE_NAME; });
      schema[t.TABLE_NAME] = {
        rowCount: t.TABLE_ROWS,
        columns: cols.map(c => ({
          name: c.COLUMN_NAME,
          type: c.COLUMN_TYPE,
          pk: c.COLUMN_KEY === 'PRI',
          fk: fkMap[c.COLUMN_NAME] || null,
          nullable: c.IS_NULLABLE === 'YES'
        }))
      };
    }
    res.json(schema);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Procedures and triggers
app.get('/api/routines', async (req, res) => {
  try {
    const { rows: procs } = await query(
      `SELECT ROUTINE_NAME, ROUTINE_TYPE, ROUTINE_DEFINITION FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?`,
      [dbConfig.database]
    );
    const { rows: triggers } = await query(
      `SELECT TRIGGER_NAME, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_TIMING, ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`,
      [dbConfig.database]
    );
    res.json({ procedures: procs, triggers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// High risk accounts
app.get('/api/high-risk', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT a.account_id, a.user_id, u.name, a.account_type, a.balance, a.risk_score FROM Accounts a JOIN Users u ON a.user_id = u.user_id WHERE a.risk_score > 50 ORDER BY a.risk_score DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Rapid transaction detection
app.get('/api/fraud/rapid-txn', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT sender_account, COUNT(*) AS txn_count FROM Transactions WHERE created_at >= NOW() - INTERVAL 10 MINUTE GROUP BY sender_account HAVING COUNT(*) > 5`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Transfer money procedure
app.post('/api/transfer', async (req, res) => {
  const { sender, receiver, amount } = req.body;
  if (!sender || !receiver || !amount) return res.status(400).json({ error: 'sender, receiver, amount required' });
  try {
    const start = Date.now();
    await query('CALL transfer_money(?, ?, ?)', [sender, receiver, amount]);
    const ms = Date.now() - start;
    res.json({ ok: true, ms, message: `Transferred ₹${amount} from account ${sender} to ${receiver}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✓ Fraud Detection API running at http://localhost:${PORT}`);
  console.log(`✓ Dashboard UI at       http://localhost:${PORT}/index.html`);
  console.log(`  DB: ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}\n`);
}).on('error', e => {
  console.error('Server failed to start:', e.message);
});