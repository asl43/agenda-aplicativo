// ═══════════════════════════════════════════════════════════════
//  AGENDA PWA — GOOGLE APPS SCRIPT BACKEND
//  Cole este código em: script.google.com → Novo projeto
//  Depois: Implantar → Novo Implantação → App da Web
//  Executar como: Eu mesmo | Quem pode acessar: Qualquer pessoa
// ═══════════════════════════════════════════════════════════════

const SHEET_NAME   = "Lembretes";
const LOG_SHEET    = "Logs";
const CONFIG_SHEET = "Config";

// Cabeçalhos da planilha principal
const HEADERS = [
  "ID", "Usuário", "Data", "Texto", "Horário",
  "Repetição", "Categoria", "WhatsApp", "Criado Em", "Atualizado Em", "Excluído"
];

// ───────────────────────────────────────────────
//  ENTRY POINTS
// ───────────────────────────────────────────────

function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  try {
    const params = e.parameter || {};
    const action = params.action || (e.postData ? JSON.parse(e.postData.contents || '{}').action : null);
    const body   = e.postData  ? JSON.parse(e.postData.contents || '{}') : {};

    ensureSheetsExist();

    let result;
    switch (action) {
      case "ping":        result = { ok: true, ts: Date.now() };                  break;
      case "pull":        result = pullAll(params.user, params.since);            break;
      case "push":        result = pushEvents(body.user, body.events);            break;
      case "upsert":      result = upsertEvent(body.event);                       break;
      case "delete":      result = softDelete(body.id, body.user);                break;
      case "deleteAll":   result = deleteAllForUser(body.user);                   break;
      case "getUsers":    result = getUsers();                                     break;
      case "getStats":    result = getStats(params.user);                          break;
      default:            result = { error: "Ação desconhecida: " + action };
    }

    log(action, params.user || body.user || "?", "ok");
    return jsonResponse(result);

  } catch (err) {
    log("ERROR", "?", err.message);
    return jsonResponse({ error: err.message });
  }
}

// ───────────────────────────────────────────────
//  PULL — app busca tudo do Sheets
// ───────────────────────────────────────────────

function pullAll(user, since) {
  if (!user) return { error: "Usuário obrigatório" };
  const sheet = getSheet(SHEET_NAME);
  const rows  = sheet.getDataRange().getValues();
  if (rows.length <= 1) return { events: [], ts: Date.now() };

  const sinceMs = since ? parseInt(since) : 0;
  const events  = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowUser    = String(row[1]).trim();
    const updatedAt  = row[9] ? new Date(row[9]).getTime() : 0;
    const deletedAt  = row[10];

    if (rowUser !== user) continue;
    if (sinceMs && updatedAt <= sinceMs) continue;

    events.push({
      id:         String(row[0]),
      user:       rowUser,
      date:       String(row[2]),
      text:       String(row[3]),
      time:       String(row[4]),
      repeat:     String(row[5]),
      cat:        String(row[6]),
      phone:      String(row[7]),
      createdAt:  row[8] ? new Date(row[8]).getTime() : 0,
      updatedAt:  updatedAt,
      deleted:    deletedAt === true || deletedAt === "TRUE" || deletedAt === 1
    });
  }

  return { events, ts: Date.now() };
}

// ───────────────────────────────────────────────
//  PUSH — app envia snapshot completo local
// ───────────────────────────────────────────────

function pushEvents(user, events) {
  if (!user)   return { error: "Usuário obrigatório" };
  if (!events) return { error: "events[] obrigatório" };

  const sheet   = getSheet(SHEET_NAME);
  const rows    = sheet.getDataRange().getValues();
  const now     = new Date();

  // Indexar existentes por ID
  const existingById = {};
  for (let i = 1; i < rows.length; i++) {
    const id = String(rows[i][0]);
    if (String(rows[i][1]) === user) existingById[id] = i + 1; // 1-based
  }

  let inserted = 0, updated = 0;

  events.forEach(ev => {
    const rowData = [
      ev.id, user, ev.date, ev.text, ev.time || "",
      ev.repeat || "none", ev.cat || "other", ev.phone || "",
      ev.createdAt ? new Date(ev.createdAt) : now,
      now,
      ev.deleted === true
    ];

    if (existingById[ev.id]) {
      // Atualizar linha existente
      const rowNum = existingById[ev.id];
      sheet.getRange(rowNum, 1, 1, rowData.length).setValues([rowData]);
      updated++;
    } else {
      // Inserir nova linha
      sheet.appendRow(rowData);
      inserted++;
    }
  });

  formatSheet(sheet);
  return { ok: true, inserted, updated, ts: Date.now() };
}

// ───────────────────────────────────────────────
//  UPSERT — salvar/editar 1 evento
// ───────────────────────────────────────────────

function upsertEvent(ev) {
  if (!ev || !ev.id || !ev.user) return { error: "Evento inválido" };

  const sheet = getSheet(SHEET_NAME);
  const rows  = sheet.getDataRange().getValues();
  const now   = new Date();

  let targetRow = -1;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(ev.id) && String(rows[i][1]) === ev.user) {
      targetRow = i + 1; break;
    }
  }

  const rowData = [
    ev.id, ev.user, ev.date, ev.text, ev.time || "",
    ev.repeat || "none", ev.cat || "other", ev.phone || "",
    ev.createdAt ? new Date(ev.createdAt) : now,
    now,
    ev.deleted === true
  ];

  if (targetRow > 0) {
    sheet.getRange(targetRow, 1, 1, rowData.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }

  formatSheet(sheet);
  return { ok: true, id: ev.id, ts: Date.now() };
}

// ───────────────────────────────────────────────
//  SOFT DELETE — marca como excluído
// ───────────────────────────────────────────────

function softDelete(id, user) {
  if (!id || !user) return { error: "ID e usuário obrigatórios" };
  const sheet = getSheet(SHEET_NAME);
  const rows  = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id) && String(rows[i][1]) === user) {
      sheet.getRange(i + 1, 11).setValue(true);
      sheet.getRange(i + 1, 10).setValue(new Date());
      return { ok: true, id, ts: Date.now() };
    }
  }
  return { error: "Evento não encontrado" };
}

// ───────────────────────────────────────────────
//  DELETE ALL para um usuário
// ───────────────────────────────────────────────

function deleteAllForUser(user) {
  if (!user) return { error: "Usuário obrigatório" };
  const sheet = getSheet(SHEET_NAME);
  const rows  = sheet.getDataRange().getValues();
  const now   = new Date();
  let count   = 0;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1]) === user) {
      sheet.getRange(i + 1, 10).setValue(now);
      sheet.getRange(i + 1, 11).setValue(true);
      count++;
    }
  }
  return { ok: true, deleted: count, ts: Date.now() };
}

// ───────────────────────────────────────────────
//  GET USERS — lista todos usuários únicos
// ───────────────────────────────────────────────

function getUsers() {
  const sheet = getSheet(SHEET_NAME);
  const rows  = sheet.getDataRange().getValues();
  const users = new Set();
  for (let i = 1; i < rows.length; i++) {
    const u = String(rows[i][1]).trim();
    if (u) users.add(u);
  }
  return { users: [...users] };
}

// ───────────────────────────────────────────────
//  STATS
// ───────────────────────────────────────────────

function getStats(user) {
  const sheet = getSheet(SHEET_NAME);
  const rows  = sheet.getDataRange().getValues();
  const stats = { total: 0, bycat: {}, byrepeat: {}, bymonth: {} };

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (user && String(row[1]) !== user) continue;
    if (row[10] === true || row[10] === "TRUE") continue;

    stats.total++;
    const cat    = String(row[6]) || "other";
    const repeat = String(row[5]) || "none";
    const month  = String(row[2]).slice(0, 7);

    stats.bycat[cat]       = (stats.bycat[cat]    || 0) + 1;
    stats.byrepeat[repeat] = (stats.byrepeat[repeat] || 0) + 1;
    stats.bymonth[month]   = (stats.bymonth[month]  || 0) + 1;
  }
  return { stats, ts: Date.now() };
}

// ───────────────────────────────────────────────
//  HELPERS
// ───────────────────────────────────────────────

function ensureSheetsExist() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Lembretes
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length)
      .setBackground("#0e1018").setFontColor("#4ade80")
      .setFontWeight("bold").setFontSize(11);
    sh.setColumnWidth(1, 200);
    sh.setColumnWidth(4, 280);
  }

  // Logs
  let lg = ss.getSheetByName(LOG_SHEET);
  if (!lg) {
    lg = ss.insertSheet(LOG_SHEET);
    lg.appendRow(["Timestamp", "Ação", "Usuário", "Status"]);
    lg.setFrozenRows(1);
    lg.getRange(1,1,1,4).setBackground("#0e1018").setFontColor("#22d3ee").setFontWeight("bold");
  }
}

function getSheet(name) {
  ensureSheetsExist();
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function log(action, user, status) {
  try {
    const lg = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET);
    if (lg) lg.appendRow([new Date(), action, user, status]);
    // manter apenas últimas 500 linhas de log
    const rows = lg.getLastRow();
    if (rows > 501) lg.deleteRows(2, rows - 501);
  } catch(e) {}
}

function formatSheet(sheet) {
  try {
    const last = sheet.getLastRow();
    if (last < 2) return;
    // Alternar cores nas linhas
    for (let i = 2; i <= last; i++) {
      const bg = (i % 2 === 0) ? "#13151f" : "#1a1d2b";
      sheet.getRange(i, 1, 1, HEADERS.length).setBackground(bg).setFontColor("#e8eaf0");
      // Excluídos em cinza
      if (sheet.getRange(i, 11).getValue() === true) {
        sheet.getRange(i, 1, 1, HEADERS.length).setFontColor("#555a72");
      }
    }
  } catch(e) {}
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ───────────────────────────────────────────────
//  TRIGGER AUTOMÁTICO — sync a cada 5 minutos
//  Execute manualmente uma vez para instalar
// ───────────────────────────────────────────────

function installTrigger() {
  // Remove triggers antigos
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  // Cria trigger de 5 em 5 minutos
  ScriptApp.newTrigger("autoBackupLog")
    .timeBased().everyMinutes(5).create();
  Logger.log("Trigger instalado com sucesso!");
}

function autoBackupLog() {
  // Apenas registra que o sistema está vivo
  log("heartbeat", "system", "alive");
}
