'use strict';
// Worker do banco SQLite: roda UMA consulta (ou uma instrução de escrita já aprovada) fora do event loop do
// Web, para uma consulta pesada não travar o chat, a caixa e as aprovações. O chamador (ferramenta.js) impõe
// o prazo e encerra o worker se ele passar. Entrada em workerData: { arquivo, sql, bind, acao, max }.
const { parentPort, workerData } = require('node:worker_threads');

function roda() {
  const { arquivo, sql, bind, acao, max } = workerData;
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch (e) { return { erro: { status: 503, mensagem: 'Este Node não tem o módulo node:sqlite; o banco não pode ser consultado.' } }; }
  let db;
  try { db = new sqlite.DatabaseSync(arquivo, { readOnly: !acao }); } catch (e) {
    return { erro: { status: 503, mensagem: `Não consegui abrir o banco da ferramenta (${e.code || e.message}). O dono precisa conferir o arquivo no catálogo.` } };
  }
  try {
    const st = db.prepare(sql);
    if (acao) { const r = st.run(bind); return { ok: { item: { alteradas: Number(r.changes) } } }; }
    const linhas = st.all(bind).slice(0, max + 1).map((l) => Object.assign({}, l));
    return { ok: { itens: linhas.slice(0, max), total: linhas.length > max ? max : linhas.length, truncado: linhas.length > max } };
  } catch (e) {
    return { erro: { status: 502, mensagem: `A consulta falhou no banco (${String(e.message).slice(0, 200)}).` } };
  } finally { try { db.close(); } catch (_) { /* já fechado */ } }
}

parentPort.postMessage(roda());
