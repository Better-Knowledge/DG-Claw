'use strict';
// Log de acesso a dados: uma linha JSON por pedido, em <dir>/acessos-AAAA-MM-DD.jsonl (pasta 700, arquivo
// 600, dentro da pasta de dados do Web, que o agente não alcança). Sem parâmetros, sem conteúdo, sem segredo:
// só quem, o quê, quando, a decisão, o motivo e o tamanho do que saiu. Retenção em dias; arquivos mais
// velhos são apagados na primeira escrita de cada dia. Contrato em web/docs/DADOS-POR-PAPEL.md.

const fs = require('node:fs');
const path = require('node:path');

const RX_ARQ = /^acessos-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MAX_MOTIVO = 300;
const CAMPOS = ['agente', 'pessoa', 'papel', 'fonte', 'operacao', 'acao', 'decisao', 'motivo', 'status', 'itens', 'bytes', 'aprovacao', 'por'];

function diaDe(ms) { return new Date(ms).toISOString().slice(0, 10); }

function criarDadosLog({ dir, log, agora, retencaoDias }) {
  const relogio = agora || (() => Date.now());
  const dias = Number.isInteger(retencaoDias) && retencaoDias > 0 ? retencaoDias : 90;
  let ultimoDiaVarrido = null;

  function varre(hoje) {
    if (ultimoDiaVarrido === hoje) return;
    ultimoDiaVarrido = hoje;
    let nomes;
    try { nomes = fs.readdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') log('aviso', `Log de dados: não consegui listar ${dir} para a retenção (${e.code || e.message}).`); return; }
    const limite = diaDe(relogio() - dias * 86400000);
    for (const n of nomes) {
      const m = RX_ARQ.exec(n);
      if (!m || m[1] >= limite) continue;
      try { fs.unlinkSync(path.join(dir, n)); log('info', `Log de dados: apaguei ${n} (mais de ${dias} dias).`); } catch (e) {
        log('aviso', `Log de dados: não consegui apagar ${n} (${e.code || e.message}).`);
      }
    }
  }

  /** Grava uma linha. Nunca lança: falha vira uma linha no log do Web. Devolve true se gravou. */
  function registrar(ev) {
    const t = relogio();
    const hoje = diaDe(t);
    const linha = { quando: new Date(t).toISOString() };
    for (const c of CAMPOS) {
      if (ev[c] === undefined || ev[c] === null) continue;
      linha[c] = c === 'motivo' ? String(ev[c]).slice(0, MAX_MOTIVO) : ev[c];
    }
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      varre(hoje);
      fs.appendFileSync(path.join(dir, `acessos-${hoje}.jsonl`), JSON.stringify(linha) + '\n', { mode: 0o600 });
      return true;
    } catch (e) {
      log('erro', `Log de dados: não consegui gravar a linha de ${ev.agente || '?'} em ${dir} (${e.code || e.message}). O pedido foi atendido mesmo assim; confira a pasta.`);
      return false;
    }
  }

  /** As últimas `n` linhas (mais recentes primeiro), lendo os arquivos do mais novo para o mais velho. */
  function ultimas(n) {
    const max = Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : 100;
    let nomes;
    try { nomes = fs.readdirSync(dir).filter((x) => RX_ARQ.test(x)).sort().reverse(); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const saida = [];
    for (const nome of nomes) {
      const linhas = fs.readFileSync(path.join(dir, nome), 'utf8').split('\n').filter(Boolean).reverse();
      for (const l of linhas) {
        try { saida.push(JSON.parse(l)); } catch (_) { /* linha quebrada: pula */ }
        if (saida.length >= max) return saida;
      }
    }
    return saida;
  }

  return { registrar, ultimas, get dir() { return dir; } };
}

module.exports = { criarDadosLog, CAMPOS };
