// =========================
// Config and shared state
// =========================
const API_BASE = window.location.origin;
let logEntries = [];
let logCount = 0;
let tableLoaded = {};
let chartInstances = {};
let currentFraudFilter = "ALL";
let refreshTimer = null;

const panelMeta = {
  overview: ["Dashboard", "Live fraud monitoring"],
  analytics: ["Analytics", "Charts & visualizations"],
  transfer: ["Transfer Money", "CALL transfer_money(sender, receiver, amount)"],
  schema: ["Schema", "information_schema — tables, columns, FK, routines"],
  "query-log": ["Query Log", "Live SQL query trace + executor"],
  "fraud-alerts": ["Fraud Alerts", "Filtered by risk level"],
  "audit-log": ["Audit Log", "Balance changes via trigger: audit_balance_update"],
  "tbl-Users": ["Users", "SELECT * FROM Users"],
  "tbl-Accounts": ["Accounts", "SELECT * FROM Accounts"],
  "tbl-Transactions": ["Transactions", "SELECT * FROM Transactions"],
  "tbl-Risk_Score_History": ["Risk History", "SELECT * FROM Risk_Score_History"]
};

// =========================
// API helper functions
// =========================
// Central fetch wrapper. Every API call includes session cookies.
async function apiFetch(url, opts = {}) {
  opts.credentials = "include";
  if (!opts.headers) opts.headers = { "Content-Type": "application/json" };
  const start = Date.now();
  try {
    const response = await fetch(`${API_BASE}${url}`, opts);
    const data = await response.json();
    return { data, ok: response.ok, ms: Date.now() - start };
  } catch (error) {
    return { data: { error: error.message }, ok: false, ms: Date.now() - start };
  }
}

// Login flow: validates user against /api/auth/login and opens dashboard.
async function doLogin() {
  const username = document.getElementById("login-user").value.trim();
  const password = document.getElementById("login-pass").value;
  document.getElementById("login-error").textContent = "";

  try {
    const response = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const data = await response.json();
    if (data.ok) {
      showAppForUser(data.username);
      initApp();
      return;
    }
    document.getElementById("login-error").textContent = data.error || "Login failed";
  } catch (error) {
    document.getElementById("login-error").textContent = "Cannot connect to server";
  }
}

async function doLogout() {
  await fetch(`${API_BASE}/api/auth/logout`, { method: "POST", credentials: "include" });
  document.getElementById("app").classList.add("app-hidden");
  document.getElementById("login-screen").style.display = "flex";
  clearInterval(refreshTimer);
}

async function checkAuth() {
  try {
    const response = await fetch(`${API_BASE}/api/auth/me`, { credentials: "include" });
    const data = await response.json();
    if (data.authenticated) {
      showAppForUser(data.username);
      initApp();
    }
  } catch (error) {}
}

// =========================
// UI update functions
// =========================
function showAppForUser(username) {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app").classList.remove("app-hidden");
  document.getElementById("sidebar-uname").textContent = username;
  document.getElementById("sidebar-avatar").textContent = username[0].toUpperCase();
}

function addLog(type, sql, ms, err) {
  logCount++;
  const entry = { type, sql, ms, err, time: new Date().toTimeString().slice(0, 8) };
  logEntries.unshift(entry);
  if (logEntries.length > 200) logEntries.pop();

  document.getElementById("log-badge").textContent = logCount;
  document.getElementById("qlog-count").textContent = `${logEntries.length} entries`;
  const body = document.getElementById("qlog-body");
  if (body.children[0]?.classList.contains("qe-empty")) body.innerHTML = "";

  const row = document.createElement("div");
  row.className = "qlog-entry";
  row.innerHTML = `
    <span class="qlog-time">${entry.time}</span>
    <span class="qlog-type ${entry.type}">${entry.type}</span>
    <span class="qlog-sql">${err ? `<span class="qlog-err">[ERROR] ${escHtml(err)}</span> — ` : ""}${escHtml(sql.slice(0, 120))}${sql.length > 120 ? "..." : ""}</span>
    <span class="qlog-ms">${ms}ms</span>`;
  body.prepend(row);
}

function clearLog() {
  logEntries = [];
  logCount = 0;
  document.getElementById("log-badge").textContent = "0";
  document.getElementById("qlog-count").textContent = "0 entries";
  document.getElementById("qlog-body").innerHTML = '<div class="qe-empty">Log cleared.</div>';
}

async function testConn() {
  const { data, ok } = await apiFetch("/api/ping");
  const dbDot = document.getElementById("db-dot");
  const dbText = document.getElementById("db-status-text");
  const apiDot = document.getElementById("api-dot");
  const apiText = document.getElementById("api-status-text");

  if (ok && data.ok) {
    dbDot.className = "brand-db-dot ok";
    dbText.textContent = `${data.host}/${data.db}`;
    apiDot.className = "status-dot ok";
    apiText.textContent = "API Connected";
  } else {
    dbDot.className = "brand-db-dot err";
    dbText.textContent = "DB Error";
    apiDot.className = "status-dot";
    apiText.textContent = "API Error";
  }
}

async function loadStats() {
  const { data, ok, ms } = await apiFetch("/api/stats");
  addLog("SELECT", "SELECT COUNT(*) FROM all tables + derived stats", ms, ok ? null : data.error);
  if (!ok) return;

  const map = {
    Users: "stat-Users",
    Accounts: "stat-Accounts",
    Transactions: "stat-Transactions",
    Fraud_Alerts: "stat-Fraud_Alerts",
    Audit_Log: "stat-Audit_Log",
    Risk_Score_History: "stat-Risk_Score_History",
    highRiskAccounts: "stat-highRisk",
    highAlerts: "stat-highAlerts",
    todayTransactions: "stat-todayTxn"
  };
  Object.entries(map).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el && data[key] !== undefined) el.textContent = Number(data[key]).toLocaleString();
  });
  document.getElementById("badge-fraud").textContent = data.Fraud_Alerts || 0;
}

async function loadInsights() {
  const { data, ok } = await apiFetch("/api/insights");
  const grid = document.getElementById("insights-grid");
  if (!ok || !Array.isArray(data)) {
    grid.innerHTML = '<div class="empty">Failed to load insights.</div>';
    return;
  }
  if (!data.length) {
    grid.innerHTML = '<div class="insight-card level-LOW"><div class="insight-icon">✅</div><div class="insight-title">System Clear</div><div class="insight-msg">No anomalies detected.</div></div>';
    return;
  }
  grid.innerHTML = data.map((insight) => `
    <div class="insight-card level-${insight.level}">
      <div class="insight-level"><span class="badge badge-${insight.level === "HIGH" ? "red" : insight.level === "MEDIUM" ? "yellow" : "green"}">${insight.level}</span></div>
      <div class="insight-icon">${insight.icon}</div>
      <div class="insight-title">${escHtml(insight.title)}</div>
      <div class="insight-msg">${escHtml(insight.message)}</div>
    </div>`).join("");
}

// This section displays fraud alerts detected by triggers and anomaly queries.
async function loadFraudSignals() {
  const wrap = document.getElementById("fraud-signals");
  const [rapid, multi] = await Promise.all([
    apiFetch("/api/fraud/rapid-txn"),
    apiFetch("/api/fraud/multiple-senders")
  ]);
  addLog("SELECT", "Fraud signal queries (rapid-txn, multiple-senders)", 0, null);

  const rapidRows = rapid.ok && rapid.data.length
    ? rapid.data.map((row) => `<tr class="row-high"><td>#${row.sender_account}</td><td><span class="badge badge-red">${row.txn_count} txns</span></td></tr>`).join("")
    : "";
  const multiRows = multi.ok && multi.data.length
    ? multi.data.map((row) => `<tr><td>#${row.receiver_account}</td><td><span class="badge badge-yellow">${row.sender_count}</span></td><td>₹${Number(row.total_received).toLocaleString()}</td></tr>`).join("")
    : "";

  wrap.innerHTML = `
    <div class="tbl-wrap">
      <div class="runtime-head"><span class="runtime-icon-red">⚡</span><span class="runtime-title">Rapid Transactions</span><span class="runtime-sub">&gt;5 txns in 10 min</span></div>
      ${rapidRows ? `<table><thead><tr><th>Account</th><th>Count</th></tr></thead><tbody>${rapidRows}</tbody></table>` : '<div class="empty">No rapid transactions detected</div>'}
    </div>
    <div class="tbl-wrap">
      <div class="runtime-head"><span class="runtime-icon-yellow">🔀</span><span class="runtime-title">Multiple Senders</span><span class="runtime-sub">&gt;2 distinct sources</span></div>
      ${multiRows ? `<table><thead><tr><th>Receiver</th><th>Senders</th><th>Total</th></tr></thead><tbody>${multiRows}</tbody></table>` : '<div class="empty">No aggregation patterns detected</div>'}
    </div>`;
}

async function loadHighRisk() {
  const { data, ok, ms } = await apiFetch("/api/high-risk");
  addLog("SELECT", "SELECT * FROM Accounts WHERE risk_score > 50", ms, ok ? null : data.error);
  const wrap = document.getElementById("high-risk-wrap");
  if (!ok || !data.length) {
    wrap.innerHTML = '<div class="empty">No high-risk accounts found.</div>';
    return;
  }

  wrap.innerHTML = `<table>
    <thead><tr><th>Account ID</th><th>User</th><th>Type</th><th>Balance</th><th>Risk Score</th><th>Level</th></tr></thead>
    <tbody>${data.map((row) => {
      const level = row.risk_score >= 70 ? "HIGH" : row.risk_score >= 50 ? "MEDIUM" : "LOW";
      const badgeClass = level === "HIGH" ? "badge-red" : level === "MEDIUM" ? "badge-yellow" : "badge-green";
      const colorVar = level === "HIGH" ? "var(--red)" : level === "MEDIUM" ? "var(--yellow)" : "var(--green)";
      return `<tr class="${level === "HIGH" ? "row-high" : ""}">
        <td><span class="value-cyan">#${row.account_id}</span></td>
        <td>${escHtml(row.name)}</td>
        <td><span class="badge badge-cyan">${row.account_type}</span></td>
        <td>₹${Number(row.balance).toLocaleString()}</td>
        <td><div class="risk-bar-wrap"><div class="risk-bar"><div class="risk-bar-fill" style="width:${row.risk_score}%;background:${colorVar}"></div></div><span class="risk-value" style="color:${colorVar}">${row.risk_score}</span></div></td>
        <td><span class="badge ${badgeClass}">${level}</span></td>
      </tr>`;
    }).join("")}</tbody></table>`;
}

async function loadFraudOverview() {
  const { data, ok, ms } = await apiFetch("/api/fraud-alerts?level=ALL");
  addLog("SELECT", "SELECT * FROM Fraud_Alerts ORDER BY created_at DESC", ms, ok ? null : data.error);
  const wrap = document.getElementById("fraud-overview-wrap");
  if (!ok || !data.length) {
    wrap.innerHTML = '<div class="empty">No fraud alerts.</div>';
    return;
  }
  wrap.innerHTML = buildFraudTable(data.slice(0, 8));
}

function buildFraudTable(rows) {
  if (!rows.length) return '<div class="empty">No alerts for this filter.</div>';
  return `<table>
    <thead><tr><th>Alert ID</th><th>Account</th><th>User</th><th>Txn ID</th><th>Type</th><th>Risk Level</th><th>Time</th></tr></thead>
    <tbody>${rows.map((row) => {
      const badgeClass = row.risk_level === "HIGH" ? "badge-red" : row.risk_level === "MEDIUM" ? "badge-yellow" : "badge-green";
      return `<tr class="${row.risk_level === "HIGH" ? "row-high" : ""}">
        <td>#${row.alert_id}</td>
        <td><span class="value-cyan">#${row.account_id}</span></td>
        <td>${escHtml(row.name || "—")}</td>
        <td>${row.txn_id ? `#${row.txn_id}` : "—"}</td>
        <td>${escHtml(row.fraud_type)}</td>
        <td><span class="badge ${badgeClass}">${row.risk_level}</span></td>
        <td class="text-muted">${formatDate(row.created_at)}</td>
      </tr>`;
    }).join("")}</tbody></table>`;
}

async function loadFraudAlerts() {
  const wrap = document.getElementById("fraud-alerts-wrap");
  wrap.innerHTML = '<div class="loading"><div class="spin"></div>Loading...</div>';
  const { data, ok, ms } = await apiFetch(`/api/fraud-alerts?level=${currentFraudFilter}`);
  addLog("SELECT", `SELECT * FROM Fraud_Alerts WHERE risk_level = '${currentFraudFilter}'`, ms, ok ? null : data.error);
  if (!ok) {
    wrap.innerHTML = `<div class="empty">${escHtml(data.error)}</div>`;
    return;
  }
  wrap.innerHTML = buildFraudTable(data);
}

function setFraudFilter(level, btn) {
  currentFraudFilter = level;
  document.querySelectorAll("#fraud-filter-bar .filter-btn").forEach((button) => button.classList.remove("active"));
  btn.classList.add("active");
  loadFraudAlerts();
}

async function loadAuditLog() {
  const wrap = document.getElementById("audit-log-wrap");
  wrap.innerHTML = '<div class="loading"><div class="spin"></div>Loading...</div>';
  const { data, ok, ms } = await apiFetch("/api/audit-log");
  addLog("SELECT", "SELECT * FROM Audit_Log + Users JOIN", ms, ok ? null : data.error);
  if (!ok) {
    wrap.innerHTML = `<div class="empty">${escHtml(data.error)}</div>`;
    return;
  }
  if (!data.length) {
    wrap.innerHTML = '<div class="empty">No audit records found.</div>';
    return;
  }
  wrap.innerHTML = `<table>
    <thead><tr><th>Log ID</th><th>Account</th><th>User</th><th>Old Balance</th><th>New Balance</th><th>Change</th><th>Action</th><th>Timestamp</th></tr></thead>
    <tbody>${data.map((row) => {
      const delta = Number(row.delta);
      return `<tr>
        <td>#${row.log_id}</td>
        <td><span class="value-cyan">#${row.account_id}</span></td>
        <td>${escHtml(row.name || "—")}</td>
        <td>₹${Number(row.old_balance).toLocaleString()}</td>
        <td>₹${Number(row.new_balance).toLocaleString()}</td>
        <td class="${delta >= 0 ? "delta-positive" : "delta-negative"}">${delta >= 0 ? "+" : ""}₹${delta.toLocaleString()}</td>
        <td><span class="badge badge-purple">${row.action_type}</span></td>
        <td class="text-muted">${formatDate(row.changed_at)}</td>
      </tr>`;
    }).join("")}</tbody></table>`;
}

async function loadTable(name) {
  if (tableLoaded[name]) return;
  const panel = document.getElementById(`panel-tbl-${name}`);
  panel.innerHTML = `<div class="loading"><div class="spin"></div>Loading ${name}...</div>`;
  const { data, ok, ms } = await apiFetch(`/api/table/${name}`);
  addLog("SELECT", `SELECT * FROM ${name} ORDER BY 1 DESC LIMIT 200`, ms, ok ? null : data.error);
  if (!ok) {
    panel.innerHTML = `<div class="empty">${escHtml(data.error)}</div>`;
    return;
  }
  const { rows, columns } = data;
  if (!rows.length) {
    panel.innerHTML = '<div class="empty">No data found.</div>';
    return;
  }

  panel.innerHTML = `
    <div class="section-header"><div class="section-title">${name}</div><div class="section-sub">${rows.length} rows · ${columns.length} columns</div></div>
    <div class="tbl-wrap"><table><thead><tr>${columns.map((column) => `<th>${column}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((row) => {
      const isHigh = (name === "Accounts" && row.risk_score > 50) || (name === "Fraud_Alerts" && row.risk_level === "HIGH");
      return `<tr class="${isHigh ? "row-high" : ""}">${columns.map((column) => {
        let val = row[column];
        if (val === null || val === undefined) return '<td><span class="text-muted">NULL</span></td>';
        if (column === "risk_level") {
          const badgeClass = val === "HIGH" ? "badge-red" : val === "MEDIUM" ? "badge-yellow" : "badge-green";
          return `<td><span class="badge ${badgeClass}">${val}</span></td>`;
        }
        if (column === "risk_score") {
          const colorVar = val > 70 ? "var(--red)" : val > 50 ? "var(--yellow)" : "var(--green)";
          return `<td><span style="color:${colorVar};font-weight:700">${val}</span></td>`;
        }
        return `<td>${val}</td>`;
      }).join("")}</tr>`;
    }).join("")}</tbody></table></div>`;
  tableLoaded[name] = true;
}

async function loadSchema() {
  const { data, ok, ms } = await apiFetch("/api/schema");
  addLog("SELECT", "SELECT FROM information_schema.TABLES, COLUMNS, KEY_COLUMN_USAGE", ms, ok ? null : data.error);
  const grid = document.getElementById("schema-grid");
  if (!ok) {
    grid.innerHTML = `<div class="empty">${escHtml(data.error)}</div>`;
    return;
  }
  grid.innerHTML = Object.entries(data).map(([tableName, info]) => `
    <div class="schema-card">
      <div class="schema-card-head"><span class="schema-card-name">⊞ ${tableName}</span><span class="schema-card-rows">~${info.rowCount || 0} rows</span></div>
      ${info.columns.map((column) => `
        <div class="schema-col"><div class="schema-col-left">${column.pk ? '<span class="pk-tag">PK</span>' : ""}${column.fk ? `<span class="fk-tag">FK→${column.fk}</span>` : ""}${escHtml(column.name)}</div><div class="schema-col-type">${column.type}</div></div>`).join("")}
    </div>`).join("");

  // This function calls stored procedure metadata and trigger metadata via API.
  const { data: routinesData, ok: routinesOk, ms: routinesMs } = await apiFetch("/api/routines");
  addLog("SELECT", "SELECT FROM information_schema.ROUTINES, TRIGGERS", routinesMs, routinesOk ? null : routinesData.error);
  const routinesGrid = document.getElementById("routines-grid");
  if (!routinesOk) {
    routinesGrid.innerHTML = `<div class="empty">${escHtml(routinesData.error)}</div>`;
    return;
  }
  const allRoutines = [
    ...routinesData.procedures.map((proc) => ({ ...proc, kind: "proc" })),
    ...routinesData.triggers.map((trigger) => ({ ...trigger, ROUTINE_NAME: trigger.TRIGGER_NAME, ROUTINE_DEFINITION: trigger.ACTION_STATEMENT, kind: "trigger" }))
  ];
  routinesGrid.innerHTML = allRoutines.map((routine) => `
    <div class="routine-card">
      <div class="routine-head"><span class="routine-name">${routine.ROUTINE_NAME}</span><span class="routine-type ${routine.kind}">${routine.kind === "proc" ? "PROCEDURE" : "TRIGGER"}</span></div>
      <div class="routine-body">${routine.kind === "trigger" ? `<p class="trigger-meta">${routine.EVENT_TIMING || routine.ACTION_TIMING} ${routine.EVENT_MANIPULATION} ON ${routine.EVENT_OBJECT_TABLE}</p>` : ""}
      <pre class="routine-code">${escHtml((routine.ROUTINE_DEFINITION || "").slice(0, 600))}${(routine.ROUTINE_DEFINITION || "").length > 600 ? "\n..." : ""}</pre></div>
    </div>`).join("");
}

// Chart rendering functions. This chart shows transaction trends from database.
function destroyChart(key) {
  if (chartInstances[key]) {
    chartInstances[key].destroy();
    delete chartInstances[key];
  }
}

async function loadTxnTimeChart() {
  destroyChart("txn-time");
  const { data, ok } = await apiFetch("/api/analytics/transactions-over-time");
  if (!ok) return;
  const ctx = document.getElementById("chart-txn-time").getContext("2d");
  chartInstances["txn-time"] = new Chart(ctx, { type: "line", data: { labels: data.map((row) => row.date ? String(row.date).slice(0, 10) : ""), datasets: [{ label: "Transactions", data: data.map((row) => row.count), borderColor: "#00d4ff", backgroundColor: "rgba(0,212,255,0.07)", fill: true, tension: 0.4, pointBackgroundColor: "#00d4ff", pointRadius: 3 }] }, options: { responsive: true, maintainAspectRatio: false } });
}

async function loadFraudDistChart() {
  destroyChart("fraud-dist");
  const { data, ok } = await apiFetch("/api/analytics/fraud-distribution");
  if (!ok) return;
  const colorMap = { HIGH: "#ff3d6b", MEDIUM: "#ffd166", LOW: "#00ff87" };
  const ctx = document.getElementById("chart-fraud-dist").getContext("2d");
  chartInstances["fraud-dist"] = new Chart(ctx, { type: "doughnut", data: { labels: data.map((row) => row.risk_level), datasets: [{ data: data.map((row) => row.count), backgroundColor: data.map((row) => colorMap[row.risk_level] || "#7a8599"), borderColor: "#0d1117", borderWidth: 3 }] }, options: { responsive: true, maintainAspectRatio: false } });
}

async function loadRiskBarChart() {
  destroyChart("risk-bar");
  const { data, ok } = await apiFetch("/api/analytics/risk-scores");
  if (!ok) return;
  const ctx = document.getElementById("chart-risk-bar").getContext("2d");
  chartInstances["risk-bar"] = new Chart(ctx, { type: "bar", data: { labels: data.map((row) => `#${row.account_id}`), datasets: [{ label: "Risk Score", data: data.map((row) => row.risk_score), backgroundColor: data.map((row) => row.risk_score >= 70 ? "#ff3d6b" : row.risk_score >= 50 ? "#ffd166" : "#00ff87"), borderRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false } });
}

async function loadRiskHistChart() {
  destroyChart("risk-hist");
  const { data, ok } = await apiFetch("/api/analytics/risk-history");
  if (!ok) return;
  const sorted = [...data].reverse();
  const ctx = document.getElementById("chart-risk-hist").getContext("2d");
  chartInstances["risk-hist"] = new Chart(ctx, { type: "line", data: { labels: sorted.map((row) => row.changed_at ? String(row.changed_at).slice(0, 16) : ""), datasets: [{ label: "Risk Score", data: sorted.map((row) => row.risk_score), borderColor: "#ff8c42", backgroundColor: "rgba(255,140,66,0.06)", fill: true, tension: 0.3, pointRadius: 2 }] }, options: { responsive: true, maintainAspectRatio: false } });
}

async function loadAnalytics() {
  await Promise.all([loadTxnTimeChart(), loadFraudDistChart(), loadRiskBarChart(), loadRiskHistChart()]);
}

async function loadTransferDropdowns() {
  const { data, ok } = await apiFetch("/api/accounts-list");
  if (!ok) return;
  const options = data.map((account) => `<option value="${account.account_id}">#${account.account_id} — ${escHtml(account.name)} (₹${Number(account.balance).toLocaleString()})</option>`).join("");
  document.getElementById("tf-sender").innerHTML = options;
  document.getElementById("tf-receiver").innerHTML = options;
}

// This function calls the stored procedure via API endpoint /api/transfer.
async function doTransfer() {
  const sender = document.getElementById("tf-sender").value;
  const receiver = document.getElementById("tf-receiver").value;
  const amount = document.getElementById("tf-amount").value;
  const messageArea = document.getElementById("tf-msg");
  const button = document.getElementById("tf-btn");

  if (!sender || !receiver || !amount) {
    messageArea.innerHTML = '<div class="form-msg err">All fields are required.</div>';
    return;
  }

  button.disabled = true;
  button.textContent = "Processing...";
  messageArea.innerHTML = '<div class="loading"><div class="spin"></div>Executing stored procedure...</div>';

  const { data, ok, ms } = await apiFetch("/api/transfer", { method: "POST", body: JSON.stringify({ sender, receiver, amount }) });
  addLog("CALL", `CALL transfer_money(${sender}, ${receiver}, ${amount})`, ms, ok ? null : data.error);
  button.disabled = false;
  button.textContent = "Execute Transfer →";

  if (ok) {
    messageArea.innerHTML = `<div class="form-msg ok">✓ ${escHtml(data.message)} · ${ms}ms</div>`;
    tableLoaded = {};
    await refreshAll();
  } else {
    messageArea.innerHTML = `<div class="form-msg err">✗ ${escHtml(data.error)}</div>`;
  }
}

async function runQuery() {
  const sql = document.getElementById("qe-input").value.trim();
  if (!sql) return;
  const result = document.getElementById("qe-result");
  result.innerHTML = '<div class="loading"><div class="spin"></div>Running...</div>';

  const { data, ok, ms } = await apiFetch("/api/query", { method: "POST", body: JSON.stringify({ sql }) });
  addLog("SELECT", sql.slice(0, 120) + (sql.length > 120 ? "..." : ""), ms, ok ? null : data.error);
  if (ok && data.rows !== undefined) {
    if (!data.rows.length) {
      result.innerHTML = `<div class="qe-meta"><span>0 rows</span><span>${ms}ms</span></div><div class="qe-empty">No results</div>`;
      return;
    }
    const head = data.columns.map((column) => `<th>${column}</th>`).join("");
    const body = data.rows.map((row) => `<tr>${data.columns.map((column) => `<td>${row[column] ?? "NULL"}</td>`).join("")}</tr>`).join("");
    result.innerHTML = `<div class="qe-meta"><span>${data.rows.length} rows · ${data.columns.length} cols</span><span>${ms}ms</span></div><div class="qe-scroll-x"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  } else {
    result.innerHTML = `<div class="qe-error">✗ ${escHtml(data.error)}</div>`;
  }
}

function setQ(query) {
  document.getElementById("qe-input").value = query;
}

// Navigation system: switches visible panel and lazily loads data.
async function nav(name) {
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
  document.getElementById(`panel-${name}`).classList.add("active");
  document.querySelector(`[data-panel="${name}"]`)?.classList.add("active");

  const [title, sub] = panelMeta[name] || [name, ""];
  document.getElementById("page-title").textContent = title;
  document.getElementById("page-sub").textContent = sub;

  if (name.startsWith("tbl-")) await loadTable(name.slice(4));
  if (name === "schema") await loadSchema();
  if (name === "analytics") await loadAnalytics();
  if (name === "fraud-alerts") await loadFraudAlerts();
  if (name === "audit-log") await loadAuditLog();
  if (name === "transfer") await loadTransferDropdowns();
}

async function loadOverview() {
  await Promise.all([loadInsights(), loadFraudSignals(), loadHighRisk(), loadFraudOverview()]);
}

async function refreshAll() {
  await testConn();
  await loadStats();
  if (document.getElementById("panel-overview").classList.contains("active")) await loadOverview();
  if (document.getElementById("panel-fraud-alerts").classList.contains("active")) await loadFraudAlerts();
  if (document.getElementById("panel-audit-log").classList.contains("active")) await loadAuditLog();
}

function escHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(dateValue) {
  if (!dateValue) return "—";
  return String(dateValue).slice(0, 16).replace("T", " ");
}

function bindEvents() {
  document.getElementById("login-btn").addEventListener("click", doLogin);
  document.getElementById("login-pass").addEventListener("keydown", (event) => { if (event.key === "Enter") doLogin(); });
  document.getElementById("logout-btn").addEventListener("click", doLogout);
  document.getElementById("refresh-btn").addEventListener("click", refreshAll);
  document.getElementById("tf-btn").addEventListener("click", doTransfer);
  document.getElementById("clear-log-btn").addEventListener("click", clearLog);
  document.getElementById("qe-run-btn").addEventListener("click", runQuery);
  document.getElementById("qe-input").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      runQuery();
    }
  });
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => nav(button.dataset.panel));
  });
  document.querySelectorAll("#fraud-filter-bar .filter-btn").forEach((button) => {
    button.addEventListener("click", () => setFraudFilter(button.dataset.filter, button));
  });
  document.querySelectorAll(".qe-preset").forEach((button) => {
    button.addEventListener("click", () => setQ(button.dataset.query));
  });
}

function initApp() {
  refreshAll().then(() => loadOverview());
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAll, 8000);
}

bindEvents();
checkAuth();
