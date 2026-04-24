require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const session = require('express-session');

const app = express();

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'fraud_admin_secret_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

// Serve frontend
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ─── DB Config ─────────────────────────────────────────────────────────────────
const dbConfig = {
  host:             process.env.DB_HOST     || 'localhost',
  port:             parseInt(process.env.DB_PORT) || 3306,
  user:             process.env.DB_USER     || 'root',
  password:         process.env.DB_PASSWORD || '',
  database:         process.env.DB_NAME     || 'fraud_detection_bank',
  waitForConnections: true,
  connectionLimit:  10,
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

async function executeTransferFallback(sender, receiver, amount) {
  const poolRef = await getPool();
  const connection = await poolRef.getConnection();
  try {
    await connection.beginTransaction();

    const [senderRows] = await connection.execute(
      'SELECT balance FROM Accounts WHERE account_id = ? FOR UPDATE',
      [sender]
    );
    const [receiverRows] = await connection.execute(
      'SELECT account_id FROM Accounts WHERE account_id = ? FOR UPDATE',
      [receiver]
    );

    if (!senderRows.length || !receiverRows.length) {
      throw new Error('Invalid sender or receiver account');
    }

    const senderBalance = Number(senderRows[0].balance);
    const transferAmount = Number(amount);
    if (senderBalance < transferAmount) {
      throw new Error('Insufficient balance');
    }

    await connection.execute(
      'UPDATE Accounts SET balance = balance - ? WHERE account_id = ?',
      [transferAmount, sender]
    );
    await connection.execute(
      'UPDATE Accounts SET balance = balance + ? WHERE account_id = ?',
      [transferAmount, receiver]
    );
    await connection.execute(
      'INSERT INTO Transactions (sender_account, receiver_account, amount) VALUES (?, ?, ?)',
      [sender, receiver, transferAmount]
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// ─── Auth Middleware ───────────────────────────────────────────────────────────
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized. Please log in.' });
}

// ─── Auth Routes ───────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.authenticated = true;
    req.session.username = username;
    res.json({ ok: true, username });
  } else {
    res.status(401).json({ ok: false, error: 'Invalid credentials' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.authenticated) {
    res.json({ authenticated: true, username: req.session.username });
  } else {
    res.json({ authenticated: false });
  }
});

// ─── Health / Ping ─────────────────────────────────────────────────────────────
app.get('/api/ping', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, db: dbConfig.database, host: dbConfig.host, ts: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const tables = ['Users', 'Accounts', 'Transactions', 'Fraud_Alerts', 'Audit_Log', 'Risk_Score_History'];
    const counts = {};
    for (const t of tables) {
      const { rows } = await query(`SELECT COUNT(*) as cnt FROM \`${t}\``);
      counts[t] = Number(rows[0].cnt);
    }
    // Additional stats
    const { rows: highRisk } = await query(`SELECT COUNT(*) as cnt FROM Accounts WHERE risk_score > 50`);
    const { rows: highAlerts } = await query(`SELECT COUNT(*) as cnt FROM Fraud_Alerts WHERE risk_level = 'HIGH'`);
    const { rows: todayTxns } = await query(`SELECT COUNT(*) as cnt FROM Transactions WHERE DATE(created_at) = CURDATE()`);
    counts.highRiskAccounts = Number(highRisk[0].cnt);
    counts.highAlerts = Number(highAlerts[0].cnt);
    counts.todayTransactions = Number(todayTxns[0].cnt);
    res.json(counts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Execute arbitrary SELECT query ───────────────────────────────────────────
app.post('/api/query', requireAuth, async (req, res) => {
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

// ─── Table data ────────────────────────────────────────────────────────────────
app.get('/api/table/:name', requireAuth, async (req, res) => {
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

// ─── Schema info ───────────────────────────────────────────────────────────────
app.get('/api/schema', requireAuth, async (req, res) => {
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

// ─── Routines (procedures + triggers) ─────────────────────────────────────────
app.get('/api/routines', requireAuth, async (req, res) => {
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

// ─── High-risk accounts ────────────────────────────────────────────────────────
app.get('/api/high-risk', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT a.account_id, a.user_id, u.name, a.account_type, a.balance, a.risk_score
       FROM Accounts a JOIN Users u ON a.user_id = u.user_id
       WHERE a.risk_score > 50 ORDER BY a.risk_score DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Rapid transaction detection ───────────────────────────────────────────────
app.get('/api/fraud/rapid-txn', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT sender_account, COUNT(*) AS txn_count
       FROM Transactions WHERE created_at >= NOW() - INTERVAL 10 MINUTE
       GROUP BY sender_account HAVING COUNT(*) > 5`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Multiple senders detection ────────────────────────────────────────────────
app.get('/api/fraud/multiple-senders', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT receiver_account, COUNT(DISTINCT sender_account) AS sender_count, SUM(amount) AS total_received
       FROM Transactions GROUP BY receiver_account
       HAVING COUNT(DISTINCT sender_account) > 2 ORDER BY sender_count DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Analytics: transactions over time ────────────────────────────────────────
app.get('/api/analytics/transactions-over-time', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT DATE(created_at) as date, COUNT(*) as count, SUM(amount) as volume
       FROM Transactions GROUP BY DATE(created_at) ORDER BY date ASC LIMIT 30`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Analytics: fraud distribution ────────────────────────────────────────────
app.get('/api/analytics/fraud-distribution', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT risk_level, COUNT(*) as count FROM Fraud_Alerts GROUP BY risk_level`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Analytics: risk score per account ────────────────────────────────────────
app.get('/api/analytics/risk-scores', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT a.account_id, u.name, a.risk_score, a.account_type
       FROM Accounts a JOIN Users u ON a.user_id = u.user_id
       ORDER BY a.risk_score DESC LIMIT 15`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Analytics: risk score history trends ─────────────────────────────────────
app.get('/api/analytics/risk-history', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT account_id, risk_score, changed_at FROM Risk_Score_History
       ORDER BY changed_at DESC LIMIT 50`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Accounts list (for transfer dropdowns) ────────────────────────────────────
app.get('/api/accounts-list', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT a.account_id, u.name, a.account_type, a.balance, a.risk_score
       FROM Accounts a JOIN Users u ON a.user_id = u.user_id ORDER BY a.account_id`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Transfer Money (stored procedure) ────────────────────────────────────────
app.post('/api/transfer', requireAuth, async (req, res) => {
  const { sender, receiver, amount } = req.body;
  if (!sender || !receiver || !amount) return res.status(400).json({ error: 'sender, receiver, amount required' });
  if (sender === receiver) return res.status(400).json({ error: 'Sender and receiver cannot be the same account' });
  if (parseFloat(amount) <= 0) return res.status(400).json({ error: 'Amount must be positive' });
  try {
    const start = Date.now();
    try {
      await query('CALL transfer_money(?, ?, ?)', [sender, receiver, amount]);
    } catch (e) {
      const msg = String(e.message || '');
      const procMissing = msg.includes('PROCEDURE') && msg.includes('does not exist');
      if (!procMissing) throw e;

      // Fallback path when stored procedure is unavailable in this DB.
      // This keeps transfer flow working for UI and viva demo.
      await executeTransferFallback(sender, receiver, amount);
    }
    const ms = Date.now() - start;
    res.json({ ok: true, ms, message: `Transferred ₹${amount} from account ${sender} to ${receiver}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AI Insights ───────────────────────────────────────────────────────────────
// Generates rule-based intelligence summaries from live DB data
app.get('/api/insights', requireAuth, async (req, res) => {
  try {
    const insights = [];

    // 1. High risk accounts
    const { rows: hiRisk } = await query(
      `SELECT a.account_id, u.name, a.risk_score FROM Accounts a
       JOIN Users u ON a.user_id = u.user_id WHERE a.risk_score > 70 ORDER BY a.risk_score DESC LIMIT 3`
    );
    hiRisk.forEach(r => {
      insights.push({
        level: 'HIGH',
        icon: '🔴',
        title: `Critical Risk: Account #${r.account_id}`,
        message: `${r.name}'s account has a risk score of ${r.risk_score}/100, indicating severe suspicious behavior. Immediate manual review recommended.`
      });
    });

    // 2. Rapid transactions
    const { rows: rapid } = await query(
      `SELECT sender_account, COUNT(*) AS cnt FROM Transactions
       WHERE created_at >= NOW() - INTERVAL 10 MINUTE GROUP BY sender_account HAVING cnt > 3`
    );
    rapid.forEach(r => {
      insights.push({
        level: 'HIGH',
        icon: '⚡',
        title: `Velocity Alert: Account #${r.sender_account}`,
        message: `Account #${r.sender_account} executed ${r.cnt} transactions in the last 10 minutes — a classic smurfing or layering pattern.`
      });
    });

    // 3. Multiple senders
    const { rows: multiSend } = await query(
      `SELECT receiver_account, COUNT(DISTINCT sender_account) AS senders FROM Transactions
       GROUP BY receiver_account HAVING senders > 3 LIMIT 3`
    );
    multiSend.forEach(r => {
      insights.push({
        level: 'MEDIUM',
        icon: '🔀',
        title: `Aggregation Pattern: Account #${r.receiver_account}`,
        message: `Account #${r.receiver_account} received funds from ${r.senders} distinct senders — may indicate money mule activity.`
      });
    });

    // 4. Total fraud trend
    const { rows: fraudCount } = await query(
      `SELECT COUNT(*) as cnt, risk_level FROM Fraud_Alerts GROUP BY risk_level`
    );
    const highCount = fraudCount.find(r => r.risk_level === 'HIGH');
    if (highCount && highCount.cnt > 0) {
      insights.push({
        level: 'MEDIUM',
        icon: '📊',
        title: 'Fraud Alert Summary',
        message: `${highCount.cnt} HIGH-risk fraud alert(s) are currently active in the system. Cross-reference with Audit Log for recent balance changes.`
      });
    }

    // 5. Dormant accounts with sudden activity
    const { rows: dormant } = await query(
      `SELECT t.sender_account, MAX(t.created_at) as last_txn, COUNT(*) as total
       FROM Transactions t GROUP BY t.sender_account
       HAVING total > 10 AND last_txn >= NOW() - INTERVAL 1 DAY LIMIT 2`
    );
    dormant.forEach(r => {
      insights.push({
        level: 'LOW',
        icon: '💤',
        title: `Unusual Activity: Account #${r.sender_account}`,
        message: `Account #${r.sender_account} has ${r.total} total transactions with recent activity — monitor for unusual patterns.`
      });
    });

    if (insights.length === 0) {
      insights.push({
        level: 'LOW',
        icon: '✅',
        title: 'System Clear',
        message: 'No significant fraud patterns detected at this time. Continue monitoring.'
      });
    }

    res.json(insights);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Fraud alerts with filter ──────────────────────────────────────────────────
app.get('/api/fraud-alerts', requireAuth, async (req, res) => {
  try {
    const { level } = req.query;
    let sql = `SELECT fa.alert_id, fa.account_id, fa.txn_id, fa.fraud_type, fa.risk_level, fa.created_at, u.name
               FROM Fraud_Alerts fa LEFT JOIN Accounts a ON fa.account_id = a.account_id
               LEFT JOIN Users u ON a.user_id = u.user_id`;
    const params = [];
    if (level && level !== 'ALL') {
      sql += ' WHERE fa.risk_level = ?';
      params.push(level);
    }
    sql += ' ORDER BY fa.created_at DESC LIMIT 100';
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/audit-log', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT 
        al.log_id,
        al.account_id,
        u.name,
        al.old_balance,
        al.new_balance,
        (al.new_balance - al.old_balance) AS delta,
        al.action_type,
        al.\`timestamp\` AS changed_at
      FROM Audit_Log al
      LEFT JOIN Accounts a ON al.account_id = a.account_id
      LEFT JOIN Users u ON a.user_id = u.user_id
      ORDER BY al.\`timestamp\` DESC
      LIMIT 100`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Start Server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✓ Fraud Detection API  →  http://localhost:${PORT}`);
  console.log(`✓ Admin Dashboard      →  http://localhost:${PORT}/index.html`);
  console.log(`  DB: ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
  console.log(`  Default login: admin / admin123  (change via .env)\n`);
}).on('error', e => {
  console.error('Server failed to start:', e.message);
});