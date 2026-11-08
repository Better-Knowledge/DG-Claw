'use strict';
// Fonte de dados em arquivo JSON local: <dir>/<nome>.json = { "itens": [ { "id": "...", ... } ] }.
// Serve de fonte fictícia (agenda, clientes, folha) para provar a camada de acesso sem sistema real.
// O arquivo fica em <dataDir>/dados/fontes/, pasta de root que o agente não alcança.

const fs = require('node:fs');
const path = require('node:path');

const LIMIT_PADRAO = 50;
const LIMIT_MAX = 200;
const MAX_TERMO = 200;
const MAX_ID = 80;
const RX_ID = /^[A-Za-z0-9._-]{1,80}$/;

class ErroFonte extends Error {
  constructor(status, mensagem) { super(mensagem); this.name = 'ErroFonte'; this.status = status; }
}

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function limiteDe(q) {
  const v = q && q.limit;
  if (v === undefined || v === null) return LIMIT_PADRAO;
  if (!Number.isInteger(v) || v < 1 || v > LIMIT_MAX) throw new ErroFonte(400, `"limit" precisa ser um inteiro de 1 a ${LIMIT_MAX} (recebi ${JSON.stringify(v)}).`);
  return v;
}

function normalizaTermo(v) {
  if (typeof v !== 'string') throw new ErroFonte(400, '"termo" é obrigatório e precisa ser um texto.');
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t) throw new ErroFonte(400, '"termo" não pode ficar vazio.');
  if (t.length > MAX_TERMO) throw new ErroFonte(400, `"termo" tem ${t.length} caracteres e o máximo é ${MAX_TERMO}.`);
  return t.toLowerCase();
}

function normalizaId(v) {
  if (typeof v !== 'string' || !RX_ID.test(v)) throw new ErroFonte(400, `"id" é obrigatório: um texto de até ${MAX_ID} caracteres entre letras, números, ponto, sublinhado e hífen.`);
  return v;
}

function soChaves(q, permitidas, onde) {
  if (!ehObjeto(q)) throw new ErroFonte(400, `${onde} precisa ser um objeto JSON.`);
  for (const k of Object.keys(q)) if (!permitidas.includes(k)) throw new ErroFonte(400, `${onde}: o campo "${String(k).slice(0, 40)}" não existe. Campos aceitos: ${permitidas.join(', ') || '(nenhum)'}.`);
}

function fonteJson({ dir, nome, campos, busca, catalogo }) {
  const arquivo = path.join(dir, `${nome}.json`);

  function itens() {
    let texto;
    try { texto = fs.readFileSync(arquivo, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw new ErroFonte(503, `A fonte "${nome}" não pôde ser lida (${e.code || e.message}). Avise o dono.`);
    }
    let d;
    try { d = JSON.parse(texto); } catch (e) { throw new ErroFonte(503, `A fonte "${nome}" está com o arquivo inválido (${e.message}). Avise o dono; nada foi devolvido.`); }
    if (!ehObjeto(d) || !Array.isArray(d.itens)) throw new ErroFonte(503, `A fonte "${nome}" precisa ter o formato {"itens": [...]}; nada foi devolvido.`);
    // Só objetos com os campos declarados: campo que não está no catálogo da fonte nunca sai, mesmo que esteja no arquivo.
    return d.itens.filter(ehObjeto).map((it) => { const o = {}; for (const c of campos) if (it[c] !== undefined) o[c] = it[c]; return o; });
  }

  return {
    nome, campos, catalogo,
    operacoes: {
      listar(q) {
        soChaves(q || {}, ['limit'], `listar em ${nome}`);
        const lim = limiteDe(q);
        const todos = itens();
        return { itens: todos.slice(0, lim), total: todos.length };
      },
      buscar(q) {
        soChaves(q || {}, ['termo', 'limit'], `buscar em ${nome}`);
        const termo = normalizaTermo(q && q.termo);
        const lim = limiteDe(q);
        const achados = itens().filter((it) => busca.some((c) => typeof it[c] === 'string' && it[c].toLowerCase().includes(termo)));
        return { itens: achados.slice(0, lim), total: achados.length };
      },
      ler(q) {
        soChaves(q || {}, ['id'], `ler em ${nome}`);
        const id = normalizaId(q && q.id);
        const it = itens().find((x) => String(x.id) === id);
        if (!it) throw new ErroFonte(404, `Não existe o item "${id}" em ${nome}.`);
        return { item: it };
      },
    },
    acoes: {},
  };
}

module.exports = { fonteJson, ErroFonte, soChaves, limiteDe, LIMIT_MAX };
