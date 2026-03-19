// ═══════════════════════════════════════════════════════════════
//  AGENDA PWA — GOOGLE APPS SCRIPT BACKEND v2
//
//  COMO USAR:
//  1. Cole este código em script.google.com → Novo projeto
//  2. Salve (Ctrl+S)
//  3. Implantar → Novo implantação → App da Web
//     - Executar como: Eu mesmo
//     - Quem pode acessar: Qualquer pessoa
//  4. Copie a URL e cole no app em ⚙️ Config
//
//  SE JÁ TINHA A VERSÃO ANTERIOR:
//  - Cole este código substituindo o antigo
//  - Implantar → Gerenciar implantações → Editar → Nova versão
//  - A planilha existente será atualizada automaticamente
// ═══════════════════════════════════════════════════════════════

// ── Nomes das abas ──
const SHEET_EVENTS  = "Lembretes";
const SHEET_HISTORY = "Historico";
const SHEET_RULES   = "Regras";
const SHEET_LOG     = "Logs";

// ── Colunas da aba Lembretes (v2 — expandida) ──
const HEADERS_EVENTS = [
  "ID",           // A  0
  "Usuário",      // B  1
  "Data",         // C  2
  "Texto",        // D  3
  "Horário",      // E  4
  "Repetição",    // F  5
  "Dia Semana",   // G  6  ← NOVO: para custom_weekday
  "Categoria",    // H  7
  "WhatsApp",     // I  8
  "Gerado Auto",  // J  9  ← NOVO: recorrência gerada automaticamente
  "ID Pai",       // K 10  ← NOVO: ID do evento pai da recorrência
  "Criado Em",    // L 11
  "Atualizado Em",// M 12
  "Excluído"      // N 13
];

// ── Colunas da aba Histórico ──
const HEADERS_HISTORY = [
  "ID", "Usuário", "Texto", "Categoria", "Data Lembrete", "Concluído Em"
];

// ── Colunas da aba Regras ──
const HEADERS_RULES = [
  "Usuário", "Categoria", "Repetição", "Dia Semana", "Criado Em"
];

// ═══════════════════════════════════════════════════════════════
//  ENTRY POINTS
// ═══════════════════════════════════════════════════════════════

function doGet(e)  { return handleRequest(e); }
function doPost(e) { return handleRequest(e); }

function handleRequest(e) {
  try {
    const params = e.parameter || {};
    const body   = e.postData ? JSON.parse(e.postData.contents || "{}") : {};
    const action = params.action || body.action;

    ensureSheetsExist();

    let result;
    switch (action) {
      case "ping":         result = { ok: true, ts: Date.now(), version: 2 };         break;
      case "pull":         result = pullEvents(params.user, params.since);             break;
      case "push":         result = pushEvents(body.user, body.events);                break;
      case "delete":       result = softDelete(body.id, body.user);                    break;
      case "deleteAll":    result = deleteAllForUser(body.user);                       break;
      case "pushHistory":  result = pushHistory(body.user, body.items);                break;
      case "pullHistory":  result = pullHistory(params.user);                          break;
      case "pushRules":    result = pushRules(body.user, body.rules);                  break;
      case "pullRules":    result = pullRules(params.user);                            break;
      case "getUsers":     result = getUsers();                                         break;
      case "getStats":     result = getStats(params.user);                              break;
      default:             result = { error: "Ação desconhecida: " + action };
    }

    log(action, params.user || body.user || "?", "ok");
    return jsonResponse(result);

  } catch (err) {
    log("ERROR", "?", err.message);
    return jsonResponse({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
//  PULL — Sheets → App
// ═══════════════════════════════════════════════════════════════

function pullEvents(user, since) {
  if (!user) return { error: "Usuário obrigatório" };

  const sheet = getSheet(SHEET_EVENTS);
  const rows  = sheet.getDataRange().getValues();
  if (rows.length <= 1) return { events: [], ts: Date.now() };

  const sinceMs = since ? parseInt(since) : 0;
  const events  = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (String(row[1]).trim() !== user) continue;

    const updatedAt = row[12] ? new Date(row[12]).getTime() : 0;
    if (sinceMs && updatedAt <= sinceMs) continue;

    const deleted = row[13] === true || row[13] === "TRUE" || row[13] === 1;

    events.push({
      id:          String(row[0]),
      user:        String(row[1]).trim(),
      date:        String(row[2]),
      text:        String(row[3]),
      time:        String(row[4]),
      repeat:      String(row[5]),
      weekday:     String(row[6]),
      cat:         String(row[7]),
      phone:       String(row[8]),
      _generated:  row[9] === true || row[9] === "TRUE",
      _parentId:   String(row[10] || ""),
      createdAt:   row[11] ? new Date(row[11]).getTime() : 0,
      updatedAt:   updatedAt,
      deleted:     deleted
    });
  }

  return { events, ts: Date.now() };
}

// ═══════════════════════════════════════════════════════════════
//  PUSH — App → Sheets
// ═══════════════════════════════════════════════════════════════

function pushEvents(user, events) {
  if (!user)   return { error: "Usuário obrigatório" };
  if (!events || !events.length) return { ok: true, inserted: 0, updated: 0, ts: Date.now() };

  const sheet = getSheet(SHEET_EVENTS);
  const rows  = sheet.getDataRange().getValues();
  const now   = new Date();

  // Indexar linhas existentes por ID
  const idx = {};
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1]) === user) idx[String(rows[i][0])] = i + 1;
  }

  let inserted = 0, updated = 0;

  events.forEach(ev => {
    const row = buildRow(ev, user, now);
    if (idx[ev.id]) {
      sheet.getRange(idx[ev.id], 1, 1, row.length).setValues([row]);
      updated++;
    } else {
      sheet.appendRow(row);
      inserted++;
    }
  });

  formatSheet(sheet, HEADERS_EVENTS.length);
  return { ok: true, inserted, updated, ts: Date.now() };
}

function buildRow(ev, user, now) {
  return [
    ev.id,
    user,
    ev.date,
    ev.text,
    ev.time        || "",
    ev.repeat      || "none",
    ev.weekday     || "",
    ev.cat         || "other",
    ev.phone       || "",
    ev._generated  === true,
    ev._parentId   || "",
    ev.createdAt   ? new Date(ev.createdAt) : now,
    now,
    ev.deleted     === true
  ];
}

// ═══════════════════════════════════════════════════════════════
//  DELETE
// ═══════════════════════════════════════════════════════════════

function softDelete(id, user) {
  if (!id || !user) return { error: "ID e usuário obrigatórios" };
  const sheet = getSheet(SHEET_EVENTS);
  const rows  = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id) && String(rows[i][1]) === user) {
      sheet.getRange(i + 1, 13).setValue(new Date()); // Atualizado Em
      sheet.getRange(i + 1, 14).setValue(true);        // Excluído
      return { ok: true, id, ts: Date.now() };
    }
  }
  return { error: "Evento não encontrado" };
}

function deleteAllForUser(user) {
  if (!user) return { error: "Usuário obrigatório" };
  const sheet = getSheet(SHEET_EVENTS);
  const rows  = sheet.getDataRange().getValues();
  const now   = new Date();
  let count   = 0;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1]) === user) {
      sheet.getRange(i + 1, 13).setValue(now);
      sheet.getRange(i + 1, 14).setValue(true);
      count++;
    }
  }
  return { ok: true, deleted: count, ts: Date.now() };
}

// ═══════════════════════════════════════════════════════════════
//  HISTÓRICO DE CONCLUÍDOS
// ═══════════════════════════════════════════════════════════════

function pushHistory(user, items) {
  if (!user || !items || !items.length) return { ok: true, inserted: 0 };

  const sheet   = getSheet(SHEET_HISTORY);
  const rows    = sheet.getDataRange().getValues();
  const existingIds = new Set();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1]) === user) existingIds.add(String(rows[i][0]));
  }

  let inserted = 0;
  items.forEach(item => {
    if (existingIds.has(String(item.id))) return; // já existe
    sheet.appendRow([
      item.id,
      user,
      item.text,
      item.cat   || "other",
      item.date  || "",
      item.doneAt ? new Date(item.doneAt) : new Date()
    ]);
    inserted++;
  });

  formatSheet(sheet, HEADERS_HISTORY.length);
  return { ok: true, inserted, ts: Date.now() };
}

function pullHistory(user) {
  if (!user) return { error: "Usuário obrigatório" };
  const sheet = getSheet(SHEET_HISTORY);
  const rows  = sheet.getDataRange().getValues();
  const items = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1]).trim() !== user) continue;
    items.push({
      id:     String(rows[i][0]),
      text:   String(rows[i][2]),
      cat:    String(rows[i][3]),
      date:   String(rows[i][4]),
      doneAt: rows[i][5] ? new Date(rows[i][5]).getTime() : 0
    });
  }
  return { items, ts: Date.now() };
}

// ═══════════════════════════════════════════════════════════════
//  REGRAS AUTOMÁTICAS
// ═══════════════════════════════════════════════════════════════

function pushRules(user, rules) {
  if (!user) return { error: "Usuário obrigatório" };

  const sheet = getSheet(SHEET_RULES);
  const rows  = sheet.getDataRange().getValues();
  const now   = new Date();

  // Remove regras antigas do usuário
  for (let i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][0]) === user) sheet.deleteRow(i + 1);
  }

  // Insere novas
  (rules || []).forEach(r => {
    sheet.appendRow([user, r.cat, r.repeat, r.weekday || "", now]);
  });

  return { ok: true, ts: Date.now() };
}

function pullRules(user) {
  if (!user) return { error: "Usuário obrigatório" };
  const sheet = getSheet(SHEET_RULES);
  const rows  = sheet.getDataRange().getValues();
  const rules = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() !== user) continue;
    rules.push({ cat: String(rows[i][1]), repeat: String(rows[i][2]), weekday: String(rows[i][3]) });
  }
  return { rules, ts: Date.now() };
}

// ═══════════════════════════════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════════════════════════════

function getUsers() {
  const sheet = getSheet(SHEET_EVENTS);
  const rows  = sheet.getDataRange().getValues();
  const users = new Set();
  for (let i = 1; i < rows.length; i++) {
    const u = String(rows[i][1]).trim();
    if (u) users.add(u);
  }
  return { users: [...users] };
}

function getStats(user) {
  const sheet = getSheet(SHEET_EVENTS);
  const rows  = sheet.getDataRange().getValues();
  const stats = { total: 0, bycat: {}, byrepeat: {}, bymonth: {}, generated: 0 };

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (user && String(row[1]) !== user) continue;
    if (row[13] === true || row[13] === "TRUE") continue;

    stats.total++;
    const cat    = String(row[7]) || "other";
    const repeat = String(row[5]) || "none";
    const month  = String(row[2]).slice(0, 7);
    if (row[9] === true) stats.generated++;

    stats.bycat[cat]       = (stats.bycat[cat]    || 0) + 1;
    stats.byrepeat[repeat] = (stats.byrepeat[repeat] || 0) + 1;
    stats.bymonth[month]   = (stats.bymonth[month]  || 0) + 1;
  }

  const histSheet = getSheet(SHEET_HISTORY);
  const histRows  = histSheet.getDataRange().getValues();
  stats.completed = 0;
  for (let i = 1; i < histRows.length; i++) {
    if (!user || String(histRows[i][1]) === user) stats.completed++;
  }

  return { stats, ts: Date.now() };
}

// ═══════════════════════════════════════════════════════════════
//  SETUP DAS PLANILHAS
// ═══════════════════════════════════════════════════════════════

function ensureSheetsExist() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Lembretes
  let sh = ss.getSheetByName(SHEET_EVENTS);
  if (!sh) {
    sh = ss.insertSheet(SHEET_EVENTS);
    sh.appendRow(HEADERS_EVENTS);
    sh.setFrozenRows(1);
    styleHeader(sh, HEADERS_EVENTS.length, "#0e1018", "#4ade80");
    sh.setColumnWidth(1, 200);  // ID
    sh.setColumnWidth(4, 260);  // Texto
    sh.setColumnWidth(12, 140); // Criado Em
    sh.setColumnWidth(13, 140); // Atualizado Em
  } else {
    // Migração: se a planilha tem a versão antiga (11 colunas), adicionar novas colunas
    const headerRow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    if (headerRow.length < HEADERS_EVENTS.length) {
      migrateSheet(sh, headerRow);
    }
  }

  // Histórico
  let hs = ss.getSheetByName(SHEET_HISTORY);
  if (!hs) {
    hs = ss.insertSheet(SHEET_HISTORY);
    hs.appendRow(HEADERS_HISTORY);
    hs.setFrozenRows(1);
    styleHeader(hs, HEADERS_HISTORY.length, "#0e1018", "#4ade80");
    hs.setColumnWidth(3, 280);
  }

  // Regras
  let rs = ss.getSheetByName(SHEET_RULES);
  if (!rs) {
    rs = ss.insertSheet(SHEET_RULES);
    rs.appendRow(HEADERS_RULES);
    rs.setFrozenRows(1);
    styleHeader(rs, HEADERS_RULES.length, "#0e1018", "#a78bfa");
  }

  // Logs
  let lg = ss.getSheetByName(SHEET_LOG);
  if (!lg) {
    lg = ss.insertSheet(SHEET_LOG);
    lg.appendRow(["Timestamp", "Ação", "Usuário", "Status"]);
    lg.setFrozenRows(1);
    styleHeader(lg, 4, "#0e1018", "#22d3ee");
  }
}

// Migração automática da v1 para v2
function migrateSheet(sh, existingHeaders) {
  // Versão antiga tinha 11 colunas, nova tem 14
  // Mapear colunas antigas para novas posições
  // Antiga: ID, Usuário, Data, Texto, Horário, Repetição, Categoria, WhatsApp, Criado Em, Atualizado Em, Excluído
  // Nova:   ID, Usuário, Data, Texto, Horário, Repetição, Dia Semana, Categoria, WhatsApp, Gerado Auto, ID Pai, Criado Em, Atualizado Em, Excluído

  const lastRow = sh.getLastRow();
  if (lastRow < 2) {
    // Apenas atualizar cabeçalho
    sh.getRange(1, 1, 1, HEADERS_EVENTS.length).setValues([HEADERS_EVENTS]);
    return;
  }

  const data = sh.getRange(2, 1, lastRow - 1, 11).getValues();
  sh.clearContents();
  sh.getRange(1, 1, 1, HEADERS_EVENTS.length).setValues([HEADERS_EVENTS]);

  const newData = data.map(row => [
    row[0],  // ID
    row[1],  // Usuário
    row[2],  // Data
    row[3],  // Texto
    row[4],  // Horário
    row[5],  // Repetição
    "",      // Dia Semana (novo)
    row[6],  // Categoria
    row[7],  // WhatsApp
    false,   // Gerado Auto (novo)
    "",      // ID Pai (novo)
    row[8],  // Criado Em
    row[9],  // Atualizado Em
    row[10]  // Excluído
  ]);

  sh.getRange(2, 1, newData.length, HEADERS_EVENTS.length).setValues(newData);
  styleHeader(sh, HEADERS_EVENTS.length, "#0e1018", "#4ade80");
  Logger.log("Migração v1→v2 concluída: " + newData.length + " linhas");
}

function getSheet(name) {
  ensureSheetsExist();
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function styleHeader(sheet, numCols, bg, fg) {
  sheet.getRange(1, 1, 1, numCols)
    .setBackground(bg)
    .setFontColor(fg)
    .setFontWeight("bold")
    .setFontSize(11);
}

function formatSheet(sheet, numCols) {
  try {
    const last = sheet.getLastRow();
    if (last < 2) return;
    for (let i = 2; i <= last; i++) {
      const bg = (i % 2 === 0) ? "#13151f" : "#1a1d2b";
      sheet.getRange(i, 1, 1, numCols).setBackground(bg).setFontColor("#e8eaf0");
      // Linhas excluídas em cinza (coluna N = 14, só para Lembretes)
      if (numCols >= 14) {
        const excluido = sheet.getRange(i, 14).getValue();
        if (excluido === true) {
          sheet.getRange(i, 1, 1, numCols).setFontColor("#555a72");
        }
      }
    }
  } catch(e) {}
}

function log(action, user, status) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const lg = ss.getSheetByName(SHEET_LOG);
    if (!lg) return;
    lg.appendRow([new Date(), action, user, status]);
    const rows = lg.getLastRow();
    if (rows > 501) lg.deleteRows(2, rows - 501);
  } catch(e) {}
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  TRIGGER — heartbeat a cada 5 min
//  Rode installTrigger() UMA VEZ manualmente para ativar
// ═══════════════════════════════════════════════════════════════

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("heartbeat").timeBased().everyMinutes(5).create();
  Logger.log("Trigger instalado!");
}

function heartbeat() {
  log("heartbeat", "system", "alive");
}
