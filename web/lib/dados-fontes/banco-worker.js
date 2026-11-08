'use strict';
// Processo filho do banco SQLite: roda UMA consulta (ou uma instrução de escrita já aprovada) fora do Web, para
// uma consulta pesada não travar o chat, a caixa e as aprovações, e para o prazo valer de verdade: o chamador
// (ferramenta.js) mata o processo com SIGKILL quando estoura, o que interrompe o SQLite no meio e deixa o
// journal desfazer a escrita não confirmada. Entrada: JSON em stdin { arquivo, sql, bind, acao, max };
// saída: JSON em stdout { ok } ou { erro: { status, mensagem } }.
let entrada = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { entrada += c; });
process.stdin.on('end', () => {
  let d;
  try { d = JSON.parse(entrada); } catch (e) { process.stdout.write(JSON.stringify({ erro: { status: 500, mensagem: 'entrada do processo do banco inválida' } })); return; }
  process.stdout.write(JSON.stringify(roda(d)));
});

function roda({ arquivo, sql, bind, acao, max }) {
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
