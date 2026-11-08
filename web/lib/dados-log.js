'use strict';
// Log de acesso a dados: uma linha JSON por pedido, em <dir>/acessos-AAAA-MM-DD.jsonl (pasta 700, arquivo
// 600, dentro da pasta de dados do Web, que o agente não alcança). Sem parâmetros, sem conteúdo, sem segredo:
// só quem, o quê, quando, a decisão, o motivo e o tamanho do que saiu. Retenção em dias; arquivos mais
// velhos são apagados na primeira escrita de cada dia. Contrato em web/docs/DADOS-POR-PAPEL.md.

const fs = require('node:fs');
const path = require('node:path');

const RX_ARQ = /^acessos-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MAX_MOTIVO = 300;
const CAMPOS = ['agente', 'pessoa', 'papel', 'fonte', 'escopo', 'operacao', 'acao', 'decisao', 'motivo', 'status', 'itens', 'bytes', 'aprovacao', 'por'];

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

  /** Percorre as linhas do mais novo para o mais velho, parando em `ate` arquivos velhos demais. `fn(l)` devolve false para parar. */
  function percorre(desde, fn) {
    let nomes;
    try { nomes = fs.readdirSync(dir).filter((x) => RX_ARQ.test(x)).sort().reverse(); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const nome of nomes) {
      const dia = RX_ARQ.exec(nome)[1];
      if (desde && dia < desde) return;
      const linhas = fs.readFileSync(path.join(dir, nome), 'utf8').split('\n').filter(Boolean).reverse();
      for (const l of linhas) {
        let o; try { o = JSON.parse(l); } catch (_) { continue; }
        if (fn(o) === false) return;
      }
    }
  }

  /**
   * As linhas que batem com o filtro (mais novas primeiro). `filtro`: { limit, agente, pessoa, fonte, decisao,
   * operacao, desde (AAAA-MM-DD), ate (AAAA-MM-DD) }. Cada campo de texto é igualdade exata.
   */
  function filtrar(filtro) {
    const f = filtro || {};
    const max = Number.isInteger(f.limit) && f.limit > 0 ? Math.min(f.limit, 1000) : 100;
    const saida = [];
    percorre(f.desde, (o) => {
      const dia = String(o.quando || '').slice(0, 10);
      if (f.ate && dia > f.ate) return true;
      if (f.desde && dia < f.desde) return true;
      for (const k of ['agente', 'pessoa', 'fonte', 'decisao', 'operacao']) if (f[k] && o[k] !== f[k]) return true;
      saida.push(o);
      return saida.length < max;
    });
    return saida;
  }

  /** Contagens por agente, por fonte e por decisão desde `desde` (padrão: 30 dias), até 100 mil linhas. */
  function resumo(desde) {
    const r = { desde: desde || diaDe(relogio() - 30 * 86400000), linhas: 0, por_decisao: {}, por_agente: {}, por_fonte: {}, por_pessoa: {} };
    const soma = (o, k) => { o[k] = (o[k] || 0) + 1; };
    percorre(r.desde, (o) => {
      r.linhas++;
      soma(r.por_decisao, o.decisao || '?');
      soma(r.por_agente, o.agente || '?');
      soma(r.por_fonte, o.fonte || '?');
      if (o.pessoa) soma(r.por_pessoa, o.pessoa);
      return r.linhas < 100000;
    });
    return r;
  }

  /** CSV das linhas (cabeçalho fixo), para planilha. Sem conteúdo porque o log não o tem. */
  function csv(linhas) {
    const cols = ['quando', ...CAMPOS];
    // Célula que começa com = + - @ ou tabulação vira fórmula numa planilha (CSV injection): ganha um apóstrofo na
    // frente, como as planilhas fazem para "texto literal". Número fica número.
    const cel = (v) => {
      if (v === undefined || v === null) return '';
      let t = String(v);
      if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return /[",\n\r;]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    return [cols.join(','), ...linhas.map((l) => cols.map((c) => cel(l[c])).join(','))].join('\r\n') + '\r\n';
  }

  return { registrar, ultimas, filtrar, resumo, csv, get dir() { return dir; } };
}

module.exports = { criarDadosLog, CAMPOS };
