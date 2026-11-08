'use strict';
// Catálogo das ferramentas (sistemas com API, servidores MCP e bancos de dados) que os agentes alcançam pelo
// gateway: /etc/dgclaw/ferramentas.json (root, 600). Cada ferramenta tem um tipo, uma credencial (o NOME de um
// arquivo em /etc/dgclaw/cofre-sistemas/, nunca o valor) e um catálogo fechado de operações, cada uma com o
// escopo que a libera (ex.: "crm:ler"), o esquema dos parâmetros e se é ação (executa só com aprovação).
// Contrato em web/docs/FERRAMENTAS-POR-ESCOPO.md. Quem decide é dados-decisao.js (decidirFerramenta).
//
// {
//   "versao": 1,
//   "ferramentas": {
//     "crm": { "tipo": "api", "titulo": "CRM", "base_url": "https://crm.exemplo.test/api", "credencial": "crm",
//              "auth": { "tipo": "bearer" },                      // ou { "tipo": "cabecalho", "nome": "X-Api-Key" } | { "tipo": "basico" } | { "tipo": "nenhuma" }
//              "catalogo": { "dono": "comercial", "classificacao": "pessoal", "finalidade": "...", "retencao_dias": 0 },
//              "operacoes": {
//                "clientes_listar": { "metodo": "GET", "rota": "/clientes", "escopo": "crm:ler",
//                                     "params": { "q": { "tipo": "texto", "max": 100 }, "limit": { "tipo": "inteiro", "min": 1, "max": 200, "padrao": 50 } },
//                                     "campos": ["id", "nome", "telefone"] },
//                "cliente_ler":     { "metodo": "GET", "rota": "/clientes/{id}", "escopo": "crm:ler", "params": { "id": { "tipo": "texto", "regex": "^[0-9]{1,12}$", "obrigatorio": true } } },
//                "proposta_criar":  { "metodo": "POST", "rota": "/propostas", "escopo": "crm:escrever", "acao": true, "params": { ... } } } },
//     "vendas": { "tipo": "banco", "arquivo": "/var/lib/dgclaw/dados/vendas.sqlite",
//                 "operacoes": { "resumo_mes": { "sql": "SELECT produto, SUM(valor) AS total FROM vendas WHERE mes = :mes GROUP BY produto", "escopo": "vendas:ler", "params": { "mes": { "tipo": "periodo", "obrigatorio": true } } } } },
//     "notion": { "tipo": "mcp", "comando": "node", "args": ["/opt/mcp/notion.js"], "credencial": "notion", "credencial_env": "NOTION_TOKEN",
//                 "operacoes": { "buscar": { "tool": "search", "escopo": "notion:ler", "params": { "query": { "tipo": "texto", "obrigatorio": true } } } } }
//   }
// }

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validaEsquema } = require('./dados-fontes/esquema');

const RX_NOME = /^[a-z][a-z0-9_-]{0,39}$/;
const RX_ESCOPO = /^[a-z][a-z0-9_-]{0,39}:[a-z][a-z0-9_-]{0,39}$/;
const RX_CAMPO = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/;
const RX_ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const TIPOS = ['api', 'banco', 'mcp'];
const METODOS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const AUTHS = ['bearer', 'cabecalho', 'basico', 'nenhuma'];
const CLASSIFICACOES = ['publico', 'interno', 'pessoal', 'sensivel'];
const CAMPOS_RAIZ = ['versao', 'ferramentas', 'comentario'];
const CAMPOS_COMUNS = ['tipo', 'titulo', 'credencial', 'catalogo', 'operacoes', 'comentario', 'timeout_s'];
const CAMPOS_POR_TIPO = { api: ['base_url', 'auth'], banco: ['arquivo'], mcp: ['comando', 'args', 'credencial_env', 'env'] };
const CAMPOS_OP_COMUNS = ['escopo', 'params', 'acao', 'descricao', 'comentario', 'campos', 'max_itens'];
const CAMPOS_OP_POR_TIPO = { api: ['metodo', 'rota'], banco: ['sql'], mcp: ['tool'] };
const MAX_FERRAMENTAS = 200;
const MAX_OPERACOES = 100;
const TIMEOUT_PADRAO_S = 20;
const TIMEOUT_MAX_S = 25;     // a caixa do agente responde em 30 s

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const textoCurto = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

function validaCatalogoDaFerramenta(c, onde, erros) {
  const cat = c === undefined ? {} : c;
  if (!ehObjeto(cat)) { erros.push(`${onde}.catalogo precisa ser um objeto.`); return {}; }
  for (const k of Object.keys(cat)) if (!['dono', 'classificacao', 'finalidade', 'retencao_dias'].includes(k)) erros.push(`${onde}.catalogo tem o campo desconhecido "${String(k).slice(0, 40)}".`);
  if (cat.dono !== undefined && !textoCurto(cat.dono, 80)) erros.push(`${onde}.catalogo.dono precisa ser um texto de até 80 caracteres.`);
  if (cat.classificacao !== undefined && !CLASSIFICACOES.includes(cat.classificacao)) erros.push(`${onde}.catalogo.classificacao precisa ser um de: ${CLASSIFICACOES.join(', ')}.`);
  if (cat.finalidade !== undefined && !textoCurto(cat.finalidade, 300)) erros.push(`${onde}.catalogo.finalidade precisa ser um texto de até 300 caracteres.`);
  if (cat.retencao_dias !== undefined && !(Number.isInteger(cat.retencao_dias) && cat.retencao_dias >= 0 && cat.retencao_dias <= 36500)) erros.push(`${onde}.catalogo.retencao_dias precisa ser um inteiro de 0 a 36500.`);
  return { dono: typeof cat.dono === 'string' ? cat.dono : 'nao-informado', classificacao: cat.classificacao || 'interno', finalidade: typeof cat.finalidade === 'string' ? cat.finalidade : '', retencao_dias: Number.isInteger(cat.retencao_dias) ? cat.retencao_dias : 0 };
}

function validaOperacao(tipo, nomeOp, op, onde, erros) {
  if (!RX_NOME.test(nomeOp)) { erros.push(`${onde}: o nome de operação "${String(nomeOp).slice(0, 40)}" não vale (a-z, 0-9, _ e -, começando por letra, até 40).`); return null; }
  const o = `${onde}.operacoes.${nomeOp}`;
  if (!ehObjeto(op)) { erros.push(`${o} precisa ser um objeto.`); return null; }
  const aceitos = CAMPOS_OP_COMUNS.concat(CAMPOS_OP_POR_TIPO[tipo]);
  for (const k of Object.keys(op)) if (!aceitos.includes(k)) erros.push(`${o} tem o campo desconhecido "${String(k).slice(0, 40)}". Campos aceitos: ${aceitos.join(', ')}.`);
  if (typeof op.escopo !== 'string' || !RX_ESCOPO.test(op.escopo)) erros.push(`${o}.escopo é obrigatório, no formato "sistema:nivel" (ex.: crm:ler).`);
  if (op.acao !== undefined && typeof op.acao !== 'boolean') erros.push(`${o}.acao precisa ser true ou false.`);
  if (op.descricao !== undefined && !textoCurto(op.descricao, 300)) erros.push(`${o}.descricao precisa ser um texto de até 300 caracteres.`);
  const ep = validaEsquema(op.params);
  if (ep) erros.push(`${o}: ${ep}`);
  if (op.campos !== undefined && (!Array.isArray(op.campos) || !op.campos.length || op.campos.length > 100 || op.campos.some((c) => typeof c !== 'string' || !RX_CAMPO.test(c)))) erros.push(`${o}.campos precisa ser uma lista de até 100 nomes de campo.`);
  if (op.max_itens !== undefined && !(Number.isInteger(op.max_itens) && op.max_itens >= 1 && op.max_itens <= 1000)) erros.push(`${o}.max_itens precisa ser um inteiro de 1 a 1000.`);
  if (tipo === 'api') {
    if (!METODOS.includes(op.metodo)) erros.push(`${o}.metodo precisa ser um de: ${METODOS.join(', ')}.`);
    if (typeof op.rota !== 'string' || !op.rota.startsWith('/') || op.rota.length > 300 || /[\s\u0000-\u001f\u007f?#]/.test(op.rota)) erros.push(`${o}.rota precisa começar por "/", sem espaço, "?" ou "#", até 300 caracteres (use {nome} para encaixar um parâmetro).`);
    else {
      for (const m of op.rota.matchAll(/\{([^}]*)\}/g)) {
        if (!op.params || !Object.prototype.hasOwnProperty.call(op.params, m[1])) { erros.push(`${o}.rota usa {${m[1].slice(0, 40)}}, que não está em "params".`); continue; }
        // O que entra na rota muda para onde a chamada vai: texto livre não serve; só tipo fechado ou texto com regex.
        const pr = op.params[m[1]];
        if (ehObjeto(pr) && pr.tipo === 'texto' && (typeof pr.regex !== 'string' || !pr.regex)) erros.push(`${o}: o parâmetro {${m[1]}} entra na rota e por isso precisa de "regex" (texto livre na rota não é catálogo fechado).`);
        if (ehObjeto(pr) && (pr.tipo === 'booleano' || pr.tipo === 'numero')) erros.push(`${o}: o parâmetro {${m[1]}} entra na rota e precisa ser texto com regex, inteiro, enum, periodo ou data.`);
      }
    }
    if (op.metodo === 'GET' && op.acao === true) erros.push(`${o}: GET não pode ser ação (acao: true); ação é escrita.`);
    if (op.metodo !== 'GET' && op.acao !== true) erros.push(`${o}: ${op.metodo} escreve no sistema e por isso precisa de "acao": true (executa só com aprovação).`);
  }
  if (tipo === 'banco') {
    if (typeof op.sql !== 'string' || !op.sql.trim() || op.sql.length > 4000) erros.push(`${o}.sql é obrigatório (até 4000 caracteres).`);
    else {
      const sql = op.sql.trim();
      if (sql.includes(';')) erros.push(`${o}.sql não pode ter ";" (uma instrução só).`);
      const leitura = /^(select|with)\b/i.test(sql);
      if (!leitura && op.acao !== true) erros.push(`${o}.sql não é SELECT/WITH e por isso precisa de "acao": true (executa só com aprovação).`);
      if (leitura && op.acao === true) erros.push(`${o}: SELECT não pode ser ação.`);
      const noSql = new Set();
      for (const m of sql.matchAll(/:([a-z][a-z0-9_]*)/g)) {
        noSql.add(m[1]);
        if (!op.params || !Object.prototype.hasOwnProperty.call(op.params, m[1])) erros.push(`${o}.sql usa :${m[1]}, que não está em "params".`);
      }
      for (const nomeP of Object.keys(ehObjeto(op.params) ? op.params : {})) if (!noSql.has(nomeP)) erros.push(`${o}: o parâmetro "${nomeP}" não aparece no sql como :${nomeP}; tire-o ou use-o.`);
    }
  }
  if (tipo === 'mcp') {
    if (typeof op.tool !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(op.tool)) erros.push(`${o}.tool é obrigatório: o nome da tool no servidor MCP.`);
  }
  return { escopo: op.escopo, acao: op.acao === true, descricao: typeof op.descricao === 'string' ? op.descricao : '', params: op.params || {}, campos: op.campos || null, max_itens: op.max_itens || 200, metodo: op.metodo, rota: op.rota, sql: op.sql, tool: op.tool };
}

/** Valida e normaliza. Devolve { ok: true, ferramentas } ou { ok: false, erros }. Nunca lança. */
function validaFerramentas(bruto) {
  const erros = [];
  if (!ehObjeto(bruto)) return { ok: false, erros: ['O catálogo de ferramentas precisa ser um objeto JSON {"versao":1,"ferramentas":{}}.'] };
  for (const k of Object.keys(bruto)) if (!CAMPOS_RAIZ.includes(k)) erros.push(`A raiz tem o campo desconhecido "${String(k).slice(0, 40)}".`);
  if (bruto.versao !== 1) erros.push(`O campo "versao" precisa ser 1 (veio ${JSON.stringify(bruto.versao)}).`);
  const bf = bruto.ferramentas === undefined ? {} : bruto.ferramentas;
  const ferramentas = {};
  if (!ehObjeto(bf)) erros.push('"ferramentas" precisa ser um objeto { "<nome>": {...} }.');
  else {
    if (Object.keys(bf).length > MAX_FERRAMENTAS) erros.push(`"ferramentas" tem mais de ${MAX_FERRAMENTAS} itens.`);
    for (const [nome, f] of Object.entries(bf)) {
      const onde = `ferramentas.${String(nome).slice(0, 40)}`;
      if (!RX_NOME.test(nome)) { erros.push(`ferramentas: o nome "${String(nome).slice(0, 40)}" não vale (a-z, 0-9, _ e -, começando por letra, até 40).`); continue; }
      if (!ehObjeto(f)) { erros.push(`${onde} precisa ser um objeto.`); continue; }
      if (!TIPOS.includes(f.tipo)) { erros.push(`${onde}.tipo precisa ser um de: ${TIPOS.join(', ')}.`); continue; }
      const aceitos = CAMPOS_COMUNS.concat(CAMPOS_POR_TIPO[f.tipo]);
      for (const k of Object.keys(f)) if (!aceitos.includes(k)) erros.push(`${onde} (tipo ${f.tipo}) tem o campo desconhecido "${String(k).slice(0, 40)}". Campos aceitos: ${aceitos.join(', ')}.`);
      if (f.titulo !== undefined && !textoCurto(f.titulo, 120)) erros.push(`${onde}.titulo precisa ser um texto de até 120 caracteres.`);
      if (f.credencial !== undefined && f.credencial !== null && (typeof f.credencial !== 'string' || !RX_NOME.test(f.credencial))) erros.push(`${onde}.credencial precisa ser o NOME de uma credencial do cofre de sistemas (a-z, 0-9, _ e -), nunca o valor.`);
      if (f.timeout_s !== undefined && !(Number.isInteger(f.timeout_s) && f.timeout_s >= 1 && f.timeout_s <= TIMEOUT_MAX_S)) erros.push(`${onde}.timeout_s precisa ser um inteiro de 1 a ${TIMEOUT_MAX_S}.`);
      const catalogo = validaCatalogoDaFerramenta(f.catalogo, onde, erros);
      const norm = { tipo: f.tipo, titulo: typeof f.titulo === 'string' ? f.titulo : nome, credencial: typeof f.credencial === 'string' ? f.credencial : null, timeout_s: f.timeout_s || TIMEOUT_PADRAO_S, catalogo, operacoes: {} };
      if (f.tipo === 'api') {
        let u = null;
        try { u = new URL(f.base_url); } catch (_) { u = null; }
        if (!u || !['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) erros.push(`${onde}.base_url precisa ser um endereço http(s) sem usuário, senha, "?" ou "#".`);
        else if (u.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) erros.push(`${onde}.base_url em http só vale para a própria máquina (127.0.0.1 ou localhost); use https.`);
        norm.base_url = u ? u.toString().replace(/\/+$/, '') : null;
        const a = f.auth === undefined ? { tipo: 'nenhuma' } : f.auth;
        if (!ehObjeto(a) || !AUTHS.includes(a.tipo)) erros.push(`${onde}.auth precisa ser { "tipo": ${AUTHS.map((x) => `"${x}"`).join(' | ')} }.`);
        else {
          for (const k of Object.keys(a)) if (!['tipo', 'nome'].includes(k)) erros.push(`${onde}.auth tem o campo desconhecido "${String(k).slice(0, 40)}".`);
          if (a.tipo === 'cabecalho' && (typeof a.nome !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,60}$/.test(a.nome))) erros.push(`${onde}.auth do tipo "cabecalho" precisa de "nome" (o nome do cabeçalho, ex.: X-Api-Key).`);
          if (a.tipo !== 'nenhuma' && !norm.credencial) erros.push(`${onde}.auth do tipo "${a.tipo}" exige "credencial".`);
          if (a.tipo === 'nenhuma' && norm.credencial) erros.push(`${onde}: auth "nenhuma" com "credencial" não faz sentido.`);
        }
        norm.auth = ehObjeto(a) ? { tipo: a.tipo, nome: a.nome || null } : { tipo: 'nenhuma', nome: null };
      }
      if (f.tipo === 'banco') {
        if (typeof f.arquivo !== 'string' || !path.isAbsolute(f.arquivo) || f.arquivo.includes('..') || /[\u0000-\u001f]/.test(f.arquivo) || !/\.(sqlite|sqlite3|db)$/.test(f.arquivo)) erros.push(`${onde}.arquivo precisa ser o caminho absoluto de um arquivo .sqlite, .sqlite3 ou .db.`);
        if (norm.credencial) erros.push(`${onde}: banco SQLite não usa "credencial".`);
        norm.arquivo = f.arquivo;
      }
      if (f.tipo === 'mcp') {
        if (typeof f.comando !== 'string' || !path.isAbsolute(f.comando) || /[\s\u0000-\u001f]/.test(f.comando)) erros.push(`${onde}.comando precisa ser o caminho absoluto do programa do servidor MCP (sem espaços).`);
        if (f.args !== undefined && (!Array.isArray(f.args) || f.args.length > 30 || f.args.some((x) => typeof x !== 'string' || x.length > 300 || /[\u0000-\u001f]/.test(x)))) erros.push(`${onde}.args precisa ser uma lista de até 30 textos.`);
        if (f.credencial_env !== undefined && (typeof f.credencial_env !== 'string' || !RX_ENV.test(f.credencial_env))) erros.push(`${onde}.credencial_env precisa ser o nome de uma variável de ambiente (MAIÚSCULAS).`);
        if (norm.credencial && !f.credencial_env) erros.push(`${onde}: com "credencial", diga em qual variável ela vai ("credencial_env").`);
        if (f.env !== undefined && (!ehObjeto(f.env) || Object.keys(f.env).length > 20 || Object.entries(f.env).some(([k, v]) => !RX_ENV.test(k) || typeof v !== 'string' || v.length > 300 || /[\u0000-\u001f]/.test(v)))) erros.push(`${onde}.env precisa ser um objeto { "VAR": "valor" } com até 20 itens.`);
        else if (f.env && f.credencial_env && Object.prototype.hasOwnProperty.call(f.env, f.credencial_env)) erros.push(`${onde}.env não pode definir ${f.credencial_env}: a credencial vem do cofre de sistemas.`);
        if (f.env && Object.keys(f.env).some((k) => /(TOKEN|SECRET|KEY|PASSWORD|SENHA)/.test(k))) erros.push(`${onde}.env parece ter um segredo (TOKEN, KEY, SECRET...). Segredo vai para o cofre de sistemas, não para o catálogo.`);
        norm.comando = f.comando; norm.args = f.args || []; norm.credencial_env = f.credencial_env || null; norm.env = f.env || {};
      }
      const bo = f.operacoes === undefined ? {} : f.operacoes;
      if (!ehObjeto(bo)) erros.push(`${onde}.operacoes precisa ser um objeto { "<operacao>": {...} }.`);
      else {
        if (Object.keys(bo).length > MAX_OPERACOES) erros.push(`${onde}.operacoes tem mais de ${MAX_OPERACOES} itens.`);
        for (const [nomeOp, op] of Object.entries(bo)) {
          const n = validaOperacao(f.tipo, nomeOp, op, onde, erros);
          if (n) norm.operacoes[nomeOp] = n;
        }
      }
      ferramentas[nome] = norm;
    }
  }
  if (erros.length) return { ok: false, erros };
  return { ok: true, ferramentas };
}

const VAZIO = Object.freeze({});

function criarFerramentas({ caminho, log }) {
  let assinatura = null;
  let estado = { ok: true, erro: null, ferramentas: VAZIO, origem: 'ausente', hash: null };
  let ultimoLog = null;
  const logaUmaVez = (nivel, msg) => { if (ultimoLog === msg) return; ultimoLog = msg; log(nivel, msg); };

  function recarrega() {
    let st;
    try { st = fs.statSync(caminho); } catch (e) {
      if (assinatura === 'ausente') return;
      assinatura = 'ausente';
      estado = { ok: true, erro: null, ferramentas: VAZIO, origem: 'ausente', hash: null };
      logaUmaVez('info', `Ferramentas: não existe ${caminho} (${e.code || e.name}); nenhuma ferramenta cadastrada (web/docs/FERRAMENTAS-POR-ESCOPO.md).`);
      return;
    }
    const nova = `${st.ino}:${st.ctimeMs}:${st.mtimeMs}:${st.size}`;
    if (nova === assinatura) return;
    assinatura = nova;
    let texto;
    try { texto = fs.readFileSync(caminho, 'utf8'); } catch (e) {
      estado = { ok: false, erro: `Não consegui ler o catálogo de ferramentas ${caminho} (${e.code || e.message}). Enquanto isso nenhuma ferramenta é alcançada.`, ferramentas: VAZIO, origem: 'erro', hash: null };
      logaUmaVez('erro', `Ferramentas: ${estado.erro}`);
      return;
    }
    const hash = crypto.createHash('sha256').update(texto).digest('hex').slice(0, 12);
    let json;
    try { json = JSON.parse(texto); } catch (e) {
      estado = { ok: false, erro: `O catálogo de ferramentas ${caminho} não é JSON válido (${e.message}). Enquanto isso nenhuma ferramenta é alcançada; corrija o arquivo e o Web o relê sozinho.`, ferramentas: VAZIO, origem: 'erro', hash };
      logaUmaVez('erro', `Ferramentas: ${estado.erro}`);
      return;
    }
    const v = validaFerramentas(json);
    if (!v.ok) {
      estado = { ok: false, erro: `O catálogo de ferramentas ${caminho} tem ${v.erros.length} problema(s): ${v.erros.slice(0, 5).join(' ')}${v.erros.length > 5 ? ' (...)' : ''} Enquanto isso nenhuma ferramenta é alcançada.`, ferramentas: VAZIO, origem: 'erro', hash };
      logaUmaVez('erro', `Ferramentas: ${estado.erro}`);
      return;
    }
    estado = { ok: true, erro: null, ferramentas: v.ferramentas, origem: 'arquivo', hash };
    logaUmaVez('info', `Ferramentas carregadas de ${caminho} (sha256 ${hash}): ${Object.keys(v.ferramentas).length} ferramenta(s).`);
  }

  return {
    estado() { recarrega(); return estado; },
    obter(nome) { recarrega(); return estado.ok && Object.prototype.hasOwnProperty.call(estado.ferramentas, nome) ? estado.ferramentas[nome] : null; },
  };
}

module.exports = { validaFerramentas, criarFerramentas, RX_ESCOPO, RX_NOME, TIPOS, TIMEOUT_MAX_S };
