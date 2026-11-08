'use strict';
// Esquema de parâmetros das operações de ferramenta: catálogo fechado. Campo que não está no esquema é
// recusado; texto livre sem regra não existe; cada tipo tem os limites que precisa. Serve a dois momentos:
// validar o próprio esquema quando o catálogo de ferramentas é carregado (web/lib/ferramentas.js) e validar os
// parâmetros que o agente manda a cada chamada (web/lib/dados-fontes/ferramenta.js).

const { ErroFonte } = require('./json');

const RX_PARAM = /^[a-z][a-z0-9_]{0,39}$/;
const RX_PERIODO = /^(20\d{2})-(0[1-9]|1[0-2])$/;
const RX_DATA = /^(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIPOS = ['texto', 'inteiro', 'numero', 'booleano', 'enum', 'periodo', 'data'];
const CAMPOS_POR_TIPO = {
  texto: ['tipo', 'descricao', 'obrigatorio', 'padrao', 'regex', 'max'],
  inteiro: ['tipo', 'descricao', 'obrigatorio', 'padrao', 'min', 'max'],
  numero: ['tipo', 'descricao', 'obrigatorio', 'padrao', 'min', 'max'],
  booleano: ['tipo', 'descricao', 'obrigatorio', 'padrao'],
  enum: ['tipo', 'descricao', 'obrigatorio', 'padrao', 'valores'],
  periodo: ['tipo', 'descricao', 'obrigatorio', 'padrao'],
  data: ['tipo', 'descricao', 'obrigatorio', 'padrao'],
};
const MAX_TEXTO = 2000;
const MAX_PARAMS = 30;
// Caracteres de controle e de formatação invisível nunca entram num parâmetro de texto (mesma regra de json.js).
const { RX_INVISIVEL } = require('./json');

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Confere o esquema de UM parâmetro. Devolve null ou a frase do problema. */
function validaEsquemaParametro(nome, p) {
  const onde = `o parâmetro "${String(nome).slice(0, 40)}"`;
  if (!RX_PARAM.test(nome)) return `${onde} tem um nome que não vale (minúsculas, números e sublinhado, começando por letra, até 40).`;
  if (!ehObjeto(p)) return `${onde} precisa ser um objeto com pelo menos "tipo".`;
  if (!TIPOS.includes(p.tipo)) return `${onde} tem tipo ${JSON.stringify(p.tipo)}; os tipos são: ${TIPOS.join(', ')}.`;
  for (const k of Object.keys(p)) if (!CAMPOS_POR_TIPO[p.tipo].includes(k)) return `${onde} (tipo ${p.tipo}) não aceita o campo "${String(k).slice(0, 40)}".`;
  if (p.descricao !== undefined && (typeof p.descricao !== 'string' || p.descricao.length > 300)) return `${onde}: "descricao" precisa ser um texto de até 300 caracteres.`;
  if (p.obrigatorio !== undefined && typeof p.obrigatorio !== 'boolean') return `${onde}: "obrigatorio" precisa ser true ou false.`;
  if (p.tipo === 'texto') {
    if (p.regex !== undefined) {
      if (typeof p.regex !== 'string' || p.regex.length > 200) return `${onde}: "regex" precisa ser um texto de até 200 caracteres.`;
      try { new RegExp(p.regex, 'u'); } catch (e) { return `${onde}: a regex não compila (${e.message}).`; }
    }
    if (p.max !== undefined && !(Number.isInteger(p.max) && p.max >= 1 && p.max <= MAX_TEXTO)) return `${onde}: "max" precisa ser um inteiro de 1 a ${MAX_TEXTO}.`;
  }
  if (p.tipo === 'inteiro' || p.tipo === 'numero') {
    for (const k of ['min', 'max']) if (p[k] !== undefined && !Number.isFinite(p[k])) return `${onde}: "${k}" precisa ser um número.`;
    if (p.min !== undefined && p.max !== undefined && p.min > p.max) return `${onde}: "min" maior que "max".`;
  }
  if (p.tipo === 'enum') {
    if (!Array.isArray(p.valores) || !p.valores.length || p.valores.length > 100 || p.valores.some((v) => typeof v !== 'string' || !/^[A-Za-z0-9_.-]{1,60}$/.test(v))) {
      return `${onde} é enum e precisa de "valores": uma lista de até 100 textos curtos (letras, números, _ . -).`;
    }
  }
  if (p.padrao !== undefined) {
    const r = validaValor(nome, Object.assign({}, p, { obrigatorio: false }), p.padrao);
    if (!r.ok) return `${onde}: o "padrao" não passa no próprio esquema (${r.erro}).`;
  }
  return null;
}

/** Confere o esquema inteiro (objeto nome -> parâmetro). Devolve null ou a frase do problema. */
function validaEsquema(params) {
  if (params === undefined) return null;
  if (!ehObjeto(params)) return '"params" precisa ser um objeto { "<nome>": { "tipo": ... } } (pode ser vazio).';
  const nomes = Object.keys(params);
  if (nomes.length > MAX_PARAMS) return `"params" tem mais de ${MAX_PARAMS} parâmetros.`;
  for (const n of nomes) { const e = validaEsquemaParametro(n, params[n]); if (e) return e; }
  return null;
}

/** Confere UM valor contra o esquema do parâmetro. Devolve { ok, valor } ou { ok: false, erro }. */
function validaValor(nome, p, v) {
  const onde = `"${nome}"`;
  if (v === undefined || v === null) {
    if (p.padrao !== undefined) return { ok: true, valor: p.padrao };
    if (p.obrigatorio) return { ok: false, erro: `${onde} é obrigatório (${p.descricao || p.tipo}).` };
    return { ok: true, valor: undefined };
  }
  switch (p.tipo) {
    case 'texto': {
      if (typeof v !== 'string') return { ok: false, erro: `${onde} precisa ser um texto.` };
      const max = p.max || MAX_TEXTO;
      if (v.length > max) return { ok: false, erro: `${onde} tem ${v.length} caracteres e o máximo é ${max}.` };
      if (RX_INVISIVEL.test(v)) return { ok: false, erro: `${onde} tem caracteres invisíveis ou de controle, que são recusados.` };
      if (p.regex !== undefined && !new RegExp(p.regex, 'u').test(v)) return { ok: false, erro: `${onde} não está no formato esperado${p.descricao ? ` (${p.descricao})` : ''}.` };
      return { ok: true, valor: v };
    }
    case 'inteiro':
      if (!Number.isInteger(v)) return { ok: false, erro: `${onde} precisa ser um número inteiro.` };
      if (p.min !== undefined && v < p.min) return { ok: false, erro: `${onde} precisa ser no mínimo ${p.min}.` };
      if (p.max !== undefined && v > p.max) return { ok: false, erro: `${onde} precisa ser no máximo ${p.max}.` };
      return { ok: true, valor: v };
    case 'numero':
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, erro: `${onde} precisa ser um número.` };
      if (p.min !== undefined && v < p.min) return { ok: false, erro: `${onde} precisa ser no mínimo ${p.min}.` };
      if (p.max !== undefined && v > p.max) return { ok: false, erro: `${onde} precisa ser no máximo ${p.max}.` };
      return { ok: true, valor: v };
    case 'booleano':
      if (typeof v !== 'boolean') return { ok: false, erro: `${onde} precisa ser true ou false.` };
      return { ok: true, valor: v };
    case 'enum':
      if (typeof v !== 'string' || !p.valores.includes(v)) return { ok: false, erro: `${onde} precisa ser um de: ${p.valores.join(', ')}.` };
      return { ok: true, valor: v };
    case 'periodo':
      if (typeof v !== 'string' || !RX_PERIODO.test(v)) return { ok: false, erro: `${onde} precisa ser um mês no formato AAAA-MM.` };
      return { ok: true, valor: v };
    case 'data':
      if (typeof v !== 'string' || !RX_DATA.test(v)) return { ok: false, erro: `${onde} precisa ser uma data no formato AAAA-MM-DD.` };
      return { ok: true, valor: v };
    default:
      return { ok: false, erro: `${onde} tem um tipo desconhecido no esquema.` };
  }
}

/**
 * Valida os parâmetros de uma chamada contra o esquema. Campo fora do esquema é recusado. Devolve só os
 * campos aceitos, com os padrões preenchidos. Lança ErroFonte(400) com a frase do problema.
 */
function validaParams(esquema, bruto, onde) {
  const e = esquema || {};
  if (!ehObjeto(bruto)) throw new ErroFonte(400, `${onde}: os parâmetros precisam ser um objeto JSON.`);
  for (const k of Object.keys(bruto)) {
    if (!Object.prototype.hasOwnProperty.call(e, k)) throw new ErroFonte(400, `${onde}: o parâmetro "${String(k).slice(0, 40)}" não existe. Parâmetros aceitos: ${Object.keys(e).join(', ') || '(nenhum)'}.`);
  }
  const saida = {};
  for (const [nome, p] of Object.entries(e)) {
    const r = validaValor(nome, p, bruto[nome]);
    if (!r.ok) throw new ErroFonte(400, `${onde}: ${r.erro}`);
    if (r.valor !== undefined) saida[nome] = r.valor;
  }
  return saida;
}

module.exports = { validaEsquema, validaEsquemaParametro, validaValor, validaParams, TIPOS, RX_PARAM };
