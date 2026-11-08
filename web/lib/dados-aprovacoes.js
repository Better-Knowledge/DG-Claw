'use strict';
// Aprovações humanas das ações de dados. O agente pede (POST .../fontes/<fonte>/<acao>), o pedido nasce
// "pendente" com os parâmetros já validados e CONGELADOS aqui, e só uma pessoa, no painel, aprova ou recusa.
// Quem executa é o Web, com os parâmetros guardados: o agente não tem como trocar um byte depois de pedir, e
// a pessoa aprova mandando o hash que viu na tela, então também não aprova algo diferente do que leu.
//
// Regras: prazo (padrão 15 min); uso único (aprovada vira executada ou falhou, nunca volta a pendente);
// hash diferente, pedido vencido, já decidido ou de agente revogado = recusado com o motivo.
// Estado em <dir>/aprovacoes.json (pasta 700, arquivo 600, tmp + fsync + rename). Nenhum dado de fonte
// passa por aqui: só os parâmetros da AÇÃO (para quem, assunto, texto), que a pessoa precisa ler.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PRAZO_PADRAO_MS = 15 * 60 * 1000;
const MAX_GUARDADOS = 500;
const MAX_PENDENTES_POR_AGENTE = 10;
const MAX_PENDENTES = 200;
const MAX_PARAMS_BYTES = 64 * 1024;
const ESTADOS = ['pendente', 'aprovada', 'recusada', 'expirada', 'revogada', 'executada', 'falhou'];
const RX_ID = /^[0-9a-f]{24}$/;

class ErroAprovacao extends Error {
  constructor(status, mensagem) { super(mensagem); this.name = 'ErroAprovacao'; this.status = status; }
}

/** JSON canônico: chaves ordenadas em todo nível, sem espaço. O hash de uma ação é o sha256 disto. */
function canonico(v) {
  if (Array.isArray(v)) return '[' + v.map(canonico).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonico(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
function hashDaAcao(a) {
  return crypto.createHash('sha256').update(canonico({ agente: a.agente, fonte: a.fonte, operacao: a.operacao, acao: a.acao, params: a.params })).digest('hex');
}

function criarAprovacoes({ dir, log, agora, prazoMs }) {
  const relogio = agora || (() => Date.now());
  const prazo = prazoMs || PRAZO_PADRAO_MS;
  const arquivo = path.join(dir, 'aprovacoes.json');
  let itens = null;        // Map id -> pedido
  let assinatura = null;

  function assinaturaDoArquivo() {
    try { const st = fs.statSync(arquivo); return `${st.mtimeMs}:${st.size}`; } catch (_) { return 'ausente'; }
  }

  function carrega() {
    const sig = assinaturaDoArquivo();
    if (itens && sig === assinatura) return;
    assinatura = sig;
    itens = new Map();
    if (sig === 'ausente') return;
    try {
      const d = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
      if (!d || !Array.isArray(d.itens)) throw new Error('faltou a lista "itens"');
      for (const p of d.itens) if (p && RX_ID.test(p.id)) itens.set(p.id, p);
    } catch (e) {
      // Arquivo quebrado: não é substituído em silêncio. Fica vazio em memória e tudo pendente some da tela
      // até o dono olhar; a linha de log diz o que fazer.
      log('erro', `Aprovações de dados: ${arquivo} ilegível (${e.message}). Guardei uma cópia como ${arquivo}.quebrado e comecei uma lista vazia; os pedidos pendentes precisam ser feitos de novo.`);
      try { fs.copyFileSync(arquivo, `${arquivo}.quebrado`); } catch (_) { /* a cópia é só ajuda */ }
    }
  }

  function salva() {
    const lista = [...itens.values()].sort((a, b) => (a.pedido_em < b.pedido_em ? -1 : 1));
    // Guarda só os últimos MAX_GUARDADOS já decididos; pendentes ficam sempre.
    const decididos = lista.filter((p) => p.estado !== 'pendente');
    if (decididos.length > MAX_GUARDADOS) for (const p of decididos.slice(0, decididos.length - MAX_GUARDADOS)) itens.delete(p.id);
    const corpo = JSON.stringify({ versao: 1, itens: [...itens.values()] });
    const tmp = path.join(dir, `.aprovacoes-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeSync(fd, corpo); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, arquivo);
      assinatura = assinaturaDoArquivo();
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* não chegou a existir */ }
      throw new ErroAprovacao(503, `Não consegui gravar as aprovações em ${arquivo} (${e.code || e.message}). Confira o espaço e a permissão da pasta; nada foi alterado.`);
    }
  }

  /** Vence o que passou do prazo. Chamado em toda leitura. */
  function expira() {
    const t = relogio();
    const alvos = [...itens.values()].filter((p) => p.estado === 'pendente' && Date.parse(p.expira_em) <= t);
    if (!alvos.length) return;
    const antes = alvos.map((p) => ({ p, decidido_em: p.decidido_em }));
    for (const p of alvos) { p.estado = 'expirada'; p.decidido_em = new Date(t).toISOString(); }
    try { salva(); } catch (e) {
      // Memória e disco não podem divergir: desfaz. Os pedidos continuam vencidos pelo prazo, então aprovar já falha.
      for (const a of antes) { a.p.estado = 'pendente'; a.p.decidido_em = a.decidido_em; }
      log('aviso', `Aprovações de dados: ${alvos.length} pedido(s) venceram mas não consegui gravar (${e.message}); tento de novo na próxima leitura.`);
    }
  }

  function garante() { carrega(); expira(); }

  const iso = (t) => new Date(t).toISOString();

  /** Aplica `mudancas` em `p` e grava; se a gravação falhar, desfaz na memória antes de relançar (memória e disco nunca divergem). */
  function mutaESalva(p, mudancas) {
    const antes = {};
    for (const k of Object.keys(mudancas)) antes[k] = p[k];
    Object.assign(p, mudancas);
    try { salva(); } catch (e) { Object.assign(p, antes); throw e; }
  }

  /**
   * Cria um pedido pendente. `params` já validados pelo adaptador; `descricao` é montada pelo código, nunca pelo modelo.
   * Devolve o pedido público com `novo: true` quando acabou de nascer, `novo: false` quando já havia o mesmo pendente.
   */
  function pedir({ agente, pessoa, papel, fonte, operacao, acao, params, descricao, pedido_por }) {
    garante();
    const bytes = Buffer.byteLength(canonico(params || {}));
    if (bytes > MAX_PARAMS_BYTES) throw new ErroAprovacao(413, `Os parâmetros da ação têm ${bytes} bytes e o teto é ${MAX_PARAMS_BYTES}.`);
    // O mesmo pedido (mesmo hash) ainda pendente do mesmo agente é devolvido em vez de duplicado: a fila da pessoa não enche.
    const hash = hashDaAcao({ agente, fonte, operacao, acao, params });
    let doAgente = 0; let total = 0;
    for (const p of itens.values()) {
      if (p.estado !== 'pendente') continue;
      total++;
      if (p.agente === agente) { doAgente++; if (p.hash === hash) return Object.assign(publico(p, true), { novo: false }); }
    }
    if (doAgente >= MAX_PENDENTES_POR_AGENTE) throw new ErroAprovacao(429, `O agente ${agente} já tem ${doAgente} pedidos esperando aprovação, o máximo. Espere a pessoa decidir (ou o prazo vencer) antes de pedir outra ação.`);
    if (total >= MAX_PENDENTES) throw new ErroAprovacao(429, `Há ${total} pedidos esperando aprovação no painel, o máximo. Espere a pessoa decidir alguns antes de pedir outra ação.`);
    const t = relogio();
    const p = {
      id: crypto.randomBytes(12).toString('hex'), agente, pessoa, papel, fonte, operacao, acao, params, hash, descricao,
      pedido_por, pedido_em: iso(t), expira_em: iso(t + prazo), estado: 'pendente',
      decidido_por: null, decidido_em: null, motivo: null, resultado: null, usada_em: null,
    };
    itens.set(p.id, p);
    try { salva(); } catch (e) { itens.delete(p.id); throw e; }
    return Object.assign(publico(p, true), { novo: true });
  }

  function publico(p, comParams) {
    const o = { id: p.id, agente: p.agente, pessoa: p.pessoa, papel: p.papel, fonte: p.fonte, operacao: p.operacao, acao: p.acao, descricao: p.descricao, hash: p.hash, pedido_por: p.pedido_por, pedido_em: p.pedido_em, expira_em: p.expira_em, estado: p.estado, decidido_por: p.decidido_por, decidido_em: p.decidido_em, motivo: p.motivo, resultado: p.resultado };
    if (comParams) o.params = p.params;
    return o;
  }

  function acha(id) {
    if (typeof id !== 'string' || !RX_ID.test(id)) throw new ErroAprovacao(400, 'O id da aprovação precisa ter 24 caracteres hexadecimais.');
    garante();
    const p = itens.get(id);
    if (!p) throw new ErroAprovacao(404, `Não existe a aprovação ${id}. Ela pode ter sido apagada da lista por idade.`);
    return p;
  }

  function obter(id, comParams) { return publico(acha(id), comParams); }
  /** Lista (mais novos primeiro). Pendentes saem com os params (a pessoa precisa ler a ação); os já decididos, sem. `limit` corta. */
  function listar(filtro) {
    garante();
    const f = filtro || {};
    const lim = Number.isInteger(f.limit) && f.limit > 0 ? f.limit : 100;
    return [...itens.values()].filter((p) => !f.estado || p.estado === f.estado).filter((p) => !f.agente || p.agente === f.agente)
      .sort((a, b) => (a.pedido_em < b.pedido_em ? 1 : -1)).slice(0, lim).map((p) => publico(p, p.estado === 'pendente'));
  }
  function pendentes() { return listar({ estado: 'pendente', limit: MAX_PENDENTES + 1 }); }

  /**
   * Aprova: confere hash (o que a pessoa viu) contra o guardado E contra o recalculado dos params (arquivo
   * adulterado), prazo e estado; marca aprovada+usada numa só gravação. Devolve o pedido interno para executar.
   * `conferir(p)` é a checagem extra de quem chama (por exemplo, a política atual ainda permite a ação).
   */
  function aprovar(id, { hash, por, conferir }) {
    const p = acha(id);
    if (p.estado !== 'pendente') throw new ErroAprovacao(409, `A aprovação ${id} já está ${p.estado}; cada pedido vale uma vez só.`);
    if (typeof hash !== 'string' || hash !== p.hash || hashDaAcao(p) !== p.hash) {
      throw new ErroAprovacao(409, 'O que você está aprovando não é exatamente o que foi pedido (o hash não bate). Recarregue a página e leia o pedido de novo; se continuar diferente, recuse.');
    }
    if (conferir) {
      const problema = conferir(p);
      if (problema) {
        mutaESalva(p, { estado: 'revogada', decidido_por: por, decidido_em: iso(relogio()), motivo: problema });
        throw new ErroAprovacao(403, `Não aprovei: ${problema}`);
      }
    }
    const t = iso(relogio());
    mutaESalva(p, { estado: 'aprovada', decidido_por: por, decidido_em: t, usada_em: t });
    return p;
  }

  function concluir(id, { ok, resultado, erro }) {
    const p = acha(id);
    if (p.estado !== 'aprovada') throw new ErroAprovacao(409, `A aprovação ${id} está ${p.estado}, não aprovada.`);
    const m = { estado: ok ? 'executada' : 'falhou' };
    if (ok) m.resultado = resultado === undefined ? null : resultado; else m.motivo = String(erro || 'falhou').slice(0, 500);
    mutaESalva(p, m);
    return publico(p, true);
  }

  function recusar(id, { por, motivo }) {
    const p = acha(id);
    if (p.estado !== 'pendente') throw new ErroAprovacao(409, `A aprovação ${id} já está ${p.estado}.`);
    mutaESalva(p, { estado: 'recusada', decidido_por: por, decidido_em: iso(relogio()), motivo: motivo ? String(motivo).slice(0, 300) : null });
    return publico(p, true);
  }

  /** Revoga os pendentes que `teste(p)` apontar (agente fora dos papéis, política fechada...). Devolve quantos. */
  function revogar(teste, motivo, por) {
    garante();
    const alvos = [...itens.values()].filter((p) => p.estado === 'pendente' && teste(p));
    if (!alvos.length) return 0;
    const antes = alvos.map((p) => ({ p, estado: p.estado, decidido_por: p.decidido_por, decidido_em: p.decidido_em, motivo: p.motivo }));
    for (const p of alvos) { p.estado = 'revogada'; p.decidido_por = por || 'sistema'; p.decidido_em = iso(relogio()); p.motivo = String(motivo || 'acesso retirado').slice(0, 300); }
    try { salva(); } catch (e) { for (const a of antes) Object.assign(a.p, { estado: a.estado, decidido_por: a.decidido_por, decidido_em: a.decidido_em, motivo: a.motivo }); throw e; }
    return alvos.length;
  }

  return { pedir, obter, listar, pendentes, aprovar, concluir, recusar, revogar, ErroAprovacao };
}

module.exports = { criarAprovacoes, canonico, hashDaAcao, ErroAprovacao, ESTADOS, PRAZO_PADRAO_MS, MAX_PENDENTES_POR_AGENTE, MAX_PENDENTES };
