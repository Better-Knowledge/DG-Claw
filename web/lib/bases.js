'use strict';
// Catálogo das bases de conhecimento: /etc/dgclaw/bases.json (root, 600). Cada base é uma pasta de texto
// (Markdown, txt, csv, json) em <basesDir>/<nome>/, com um ESCOPO que diz quem a alcança e um catálogo
// (dono, classificação, finalidade, retenção). Quem decide o acesso é dados-decisao.js (decidirBase), cruzando
// o escopo da base com a pessoa e o papel do agente (web/lib/papeis.js). Contrato em web/docs/BASES-DE-CONHECIMENTO.md.
//
// Escopos:
//   privada   só a pessoa `pessoa`
//   grupo     as pessoas do grupo `grupo` (departamento ou projeto, de papeis.json)
//   empresa   toda pessoa ativa
//   publica   toda pessoa ativa, e (quando a rota externa existir) agentes de fora com chave
//
// {
//   "versao": 1,
//   "bases": {
//     "manual-rh":   { "nome": "Manual do RH", "escopo": "empresa", "dono": "rh", "classificacao": "interno",
//                      "finalidade": "procedimentos internos", "retencao_dias": 0 },
//     "contratos-x": { "escopo": "grupo", "grupo": "projeto-x", ... },
//     "notas-marta": { "escopo": "privada", "pessoa": "marta", ... },
//     "faq-site":    { "escopo": "publica", ... }
//   }
// }
// Arquivo ausente = catálogo vazio. Inválido = estado fechado (nenhuma base é alcançada) com o motivo no log.

const fs = require('node:fs');
const crypto = require('node:crypto');

const RX_NOME = /^[a-z][a-z0-9_-]{0,39}$/;
const ESCOPOS = ['privada', 'grupo', 'empresa', 'publica'];
const CLASSIFICACOES = ['publico', 'interno', 'pessoal', 'sensivel'];
const CAMPOS_RAIZ = ['versao', 'bases', 'comentario'];
const CAMPOS_BASE = ['nome', 'escopo', 'grupo', 'pessoa', 'dono', 'classificacao', 'finalidade', 'retencao_dias', 'comentario'];
const MAX_BASES = 500;

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const textoCurto = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

/** Valida e normaliza. Devolve { ok: true, bases } ou { ok: false, erros }. Nunca lança. */
function validaBases(bruto) {
  const erros = [];
  if (!ehObjeto(bruto)) return { ok: false, erros: ['O catálogo de bases precisa ser um objeto JSON {"versao":1,"bases":{}}.'] };
  for (const k of Object.keys(bruto)) if (!CAMPOS_RAIZ.includes(k)) erros.push(`A raiz tem o campo desconhecido "${String(k).slice(0, 40)}". Campos aceitos: ${CAMPOS_RAIZ.join(', ')}.`);
  if (bruto.versao !== 1) erros.push(`O campo "versao" precisa ser 1 (veio ${JSON.stringify(bruto.versao)}).`);
  const bb = bruto.bases === undefined ? {} : bruto.bases;
  const bases = {};
  if (!ehObjeto(bb)) erros.push('"bases" precisa ser um objeto { "<base>": {...} }.');
  else {
    if (Object.keys(bb).length > MAX_BASES) erros.push(`"bases" tem mais de ${MAX_BASES} itens.`);
    for (const [nome, b] of Object.entries(bb)) {
      const onde = `bases.${String(nome).slice(0, 40)}`;
      if (!RX_NOME.test(nome)) { erros.push(`bases: o nome "${String(nome).slice(0, 40)}" não vale. Use de 1 a 40 caracteres entre a-z, 0-9, _ e -, começando por letra.`); continue; }
      if (!ehObjeto(b)) { erros.push(`${onde} precisa ser um objeto.`); continue; }
      for (const k of Object.keys(b)) if (!CAMPOS_BASE.includes(k)) erros.push(`${onde} tem o campo desconhecido "${String(k).slice(0, 40)}". Campos aceitos: ${CAMPOS_BASE.join(', ')}.`);
      if (!ESCOPOS.includes(b.escopo)) { erros.push(`${onde}.escopo precisa ser um de: ${ESCOPOS.join(', ')} (veio ${JSON.stringify(b.escopo)}).`); continue; }
      if (b.escopo === 'grupo' && (typeof b.grupo !== 'string' || !RX_NOME.test(b.grupo))) erros.push(`${onde}: escopo "grupo" exige o campo "grupo" com o nome de um grupo de papeis.json.`);
      if (b.escopo !== 'grupo' && b.grupo !== undefined) erros.push(`${onde}: "grupo" só faz sentido com escopo "grupo".`);
      if (b.escopo === 'privada' && (typeof b.pessoa !== 'string' || !RX_NOME.test(b.pessoa))) erros.push(`${onde}: escopo "privada" exige o campo "pessoa" com o nome de uma pessoa de papeis.json.`);
      if (b.escopo !== 'privada' && b.pessoa !== undefined) erros.push(`${onde}: "pessoa" só faz sentido com escopo "privada".`);
      if (b.nome !== undefined && !textoCurto(b.nome, 120)) erros.push(`${onde}.nome precisa ser um texto de até 120 caracteres.`);
      if (b.dono !== undefined && !textoCurto(b.dono, 80)) erros.push(`${onde}.dono precisa ser um texto de até 80 caracteres.`);
      if (b.classificacao !== undefined && !CLASSIFICACOES.includes(b.classificacao)) erros.push(`${onde}.classificacao precisa ser um de: ${CLASSIFICACOES.join(', ')}.`);
      if (b.finalidade !== undefined && !textoCurto(b.finalidade, 300)) erros.push(`${onde}.finalidade precisa ser um texto de até 300 caracteres.`);
      if (b.retencao_dias !== undefined && !(Number.isInteger(b.retencao_dias) && b.retencao_dias >= 0 && b.retencao_dias <= 36500)) erros.push(`${onde}.retencao_dias precisa ser um inteiro de 0 (sem prazo) a 36500.`);
      bases[nome] = {
        nome: typeof b.nome === 'string' ? b.nome : nome, escopo: b.escopo, grupo: b.escopo === 'grupo' ? b.grupo : null, pessoa: b.escopo === 'privada' ? b.pessoa : null,
        dono: typeof b.dono === 'string' ? b.dono : 'nao-informado', classificacao: b.classificacao || (b.escopo === 'publica' ? 'publico' : 'interno'),
        finalidade: typeof b.finalidade === 'string' ? b.finalidade : '', retencao_dias: Number.isInteger(b.retencao_dias) ? b.retencao_dias : 0,
      };
    }
  }
  if (erros.length) return { ok: false, erros };
  return { ok: true, bases };
}

const VAZIO = Object.freeze({});

function criarBases({ caminho, log }) {
  let assinatura = null;
  let estado = { ok: true, erro: null, bases: VAZIO, origem: 'ausente', hash: null };
  let ultimoLog = null;
  const logaUmaVez = (nivel, msg) => { if (ultimoLog === msg) return; ultimoLog = msg; log(nivel, msg); };

  function recarrega() {
    let st;
    try { st = fs.statSync(caminho); } catch (e) {
      if (assinatura === 'ausente') return;
      assinatura = 'ausente';
      estado = { ok: true, erro: null, bases: VAZIO, origem: 'ausente', hash: null };
      logaUmaVez('info', `Bases de conhecimento: não existe ${caminho} (${e.code || e.name}); nenhuma base cadastrada (crie com "dgclaw base criar").`);
      return;
    }
    const nova = `${st.ino}:${st.ctimeMs}:${st.mtimeMs}:${st.size}`;
    if (nova === assinatura) return;
    assinatura = nova;
    let texto;
    try { texto = fs.readFileSync(caminho, 'utf8'); } catch (e) {
      estado = { ok: false, erro: `Não consegui ler o catálogo de bases ${caminho} (${e.code || e.message}). Enquanto isso nenhuma base é alcançada.`, bases: VAZIO, origem: 'erro', hash: null };
      logaUmaVez('erro', `Bases de conhecimento: ${estado.erro}`);
      return;
    }
    const hash = crypto.createHash('sha256').update(texto).digest('hex').slice(0, 12);
    let json;
    try { json = JSON.parse(texto); } catch (e) {
      estado = { ok: false, erro: `O catálogo de bases ${caminho} não é JSON válido (${e.message}). Enquanto isso nenhuma base é alcançada; corrija o arquivo e o Web o relê sozinho.`, bases: VAZIO, origem: 'erro', hash };
      logaUmaVez('erro', `Bases de conhecimento: ${estado.erro}`);
      return;
    }
    const v = validaBases(json);
    if (!v.ok) {
      estado = { ok: false, erro: `O catálogo de bases ${caminho} tem ${v.erros.length} problema(s): ${v.erros.slice(0, 5).join(' ')}${v.erros.length > 5 ? ' (...)' : ''} Enquanto isso nenhuma base é alcançada.`, bases: VAZIO, origem: 'erro', hash };
      logaUmaVez('erro', `Bases de conhecimento: ${estado.erro}`);
      return;
    }
    estado = { ok: true, erro: null, bases: v.bases, origem: 'arquivo', hash };
    logaUmaVez('info', `Bases de conhecimento carregadas de ${caminho} (sha256 ${hash}): ${Object.keys(v.bases).length} base(s).`);
  }

  return {
    estado() { recarrega(); return estado; },
    obter(nome) { recarrega(); return estado.ok ? estado.bases[nome] || null : null; },
  };
}

module.exports = { validaBases, criarBases, ESCOPOS, CLASSIFICACOES, RX_NOME };
