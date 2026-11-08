'use strict';
// Papéis de acesso a dados: quem (pessoa), com qual agente (papel) alcança qual fonte, e com quais campos.
// O arquivo é /etc/dgclaw/papeis.json (root, 600): quem edita é o dono ou o Admin a pedido dele; o Web só lê.
// O agente nunca alcança o arquivo (ele fica fora do container), então a permissão não é algo que ele
// consiga ampliar. Contrato completo em web/docs/DADOS-POR-PAPEL.md.
//
// Regras:
//   - o que não está escrito é negado: agente, pessoa, papel ou fonte ausente = negado;
//   - efetivo = pessoa ∩ papel (a decisão em si fica em dados-decisao.js; aqui só carga e validação);
//   - arquivo ausente = política vazia (válida, tudo negado). Arquivo inválido = estado FECHADO:
//     `estado().ok` é false e quem consulta nega tudo, com o motivo no log. O Web continua de pé porque
//     o painel é como o dono conserta o arquivo;
//   - relido quando mtime ou tamanho mudam, como o registro de agentes; cada recarga vai para o log com
//     o hash curto do conteúdo, para a trilha de "quem mudou e quando" ter um ponto de apoio.
//
// Formato (versao 1):
// {
//   "versao": 1,
//   "pessoas": { "marta": { "nome": "Marta", "fontes": { "agenda": "leitura", "clientes": { "nivel": "leitura", "campos": ["nome", "telefone"] } },
//                          "acoes": { "enviar_email": "aprovacao_humana" } } },
//   "papeis":  { "recepcao": { "fontes": { "agenda": "leitura", "folha": "negado" }, "acoes": { "enviar_email": "aprovacao_humana" } } },
//   "agentes": { "ana": { "pessoa": "marta", "papel": "recepcao" } }
// }
// Níveis de fonte: "negado" | "leitura" (ou objeto { nivel, campos }). Níveis de ação: "negado" | "aprovacao_humana".
// Não existe "livre" para ação de propósito: toda ação passa por uma pessoa.

const fs = require('node:fs');
const crypto = require('node:crypto');

const RX_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RX_NOME = /^[a-z][a-z0-9_-]{0,39}$/;      // pessoas, papéis, fontes, ações, campos
const NIVEIS_FONTE = ['negado', 'leitura'];
const NIVEIS_ACAO = ['negado', 'aprovacao_humana'];
const CAMPOS_RAIZ = ['versao', 'pessoas', 'papeis', 'agentes', 'comentario'];
const CAMPOS_PESSOA = ['nome', 'fontes', 'acoes', 'comentario'];
const CAMPOS_PAPEL = ['fontes', 'acoes', 'comentario'];
const CAMPOS_AGENTE = ['pessoa', 'papel', 'comentario'];
const CAMPOS_FONTE_OBJ = ['nivel', 'campos'];
const MAX_ITENS = 500;
const MAX_CAMPOS = 100;

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function soChaves(obj, permitidas, onde, erros) {
  for (const k of Object.keys(obj)) {
    if (!permitidas.includes(k)) erros.push(`${onde} tem o campo desconhecido "${String(k).slice(0, 40)}". Campos aceitos: ${permitidas.join(', ')}.`);
  }
}

function nomeValido(nome, onde, erros) {
  if (!RX_NOME.test(nome)) { erros.push(`${onde}: o nome "${String(nome).slice(0, 40)}" não vale. Use de 1 a 40 caracteres entre a-z, 0-9, _ e -, começando por letra.`); return false; }
  return true;
}

/** Normaliza um bloco "fontes": { nome: 'leitura' | 'negado' | { nivel, campos } } -> { nome: { nivel, campos|null } }. */
function normalizaFontes(bruto, onde, erros) {
  if (bruto === undefined) return {};
  if (!ehObjeto(bruto)) { erros.push(`${onde}.fontes precisa ser um objeto { "<fonte>": "leitura" | "negado" | { "nivel": ..., "campos": [...] } }.`); return {}; }
  const saida = {};
  for (const [fonte, v] of Object.entries(bruto)) {
    if (!nomeValido(fonte, `${onde}.fontes`, erros)) continue;
    let nivel; let campos = null;
    if (typeof v === 'string') nivel = v;
    else if (ehObjeto(v)) {
      soChaves(v, CAMPOS_FONTE_OBJ, `${onde}.fontes.${fonte}`, erros);
      nivel = v.nivel;
      if (v.campos !== undefined) {
        if (!Array.isArray(v.campos) || v.campos.length > MAX_CAMPOS || v.campos.some((c) => typeof c !== 'string' || !RX_NOME.test(c))) {
          erros.push(`${onde}.fontes.${fonte}.campos precisa ser uma lista de até ${MAX_CAMPOS} nomes de campo (a-z, 0-9, _ e -).`);
          continue;
        }
        campos = [...new Set(v.campos)];
      }
    } else { erros.push(`${onde}.fontes.${fonte} precisa ser "leitura", "negado" ou um objeto { "nivel", "campos" }.`); continue; }
    if (!NIVEIS_FONTE.includes(nivel)) { erros.push(`${onde}.fontes.${fonte}: o nível ${JSON.stringify(nivel)} não existe. Níveis de fonte: ${NIVEIS_FONTE.join(', ')}.`); continue; }
    if (nivel === 'negado' && campos) { erros.push(`${onde}.fontes.${fonte}: "campos" não faz sentido com nível "negado".`); continue; }
    saida[fonte] = { nivel, campos };
  }
  return saida;
}

function normalizaAcoes(bruto, onde, erros) {
  if (bruto === undefined) return {};
  if (!ehObjeto(bruto)) { erros.push(`${onde}.acoes precisa ser um objeto { "<acao>": "aprovacao_humana" | "negado" }.`); return {}; }
  const saida = {};
  for (const [acao, v] of Object.entries(bruto)) {
    if (!nomeValido(acao, `${onde}.acoes`, erros)) continue;
    if (!NIVEIS_ACAO.includes(v)) { erros.push(`${onde}.acoes.${acao}: o nível ${JSON.stringify(v)} não existe. Níveis de ação: ${NIVEIS_ACAO.join(', ')} (não há "livre": toda ação passa por uma pessoa).`); continue; }
    saida[acao] = v;
  }
  return saida;
}

/**
 * Valida e normaliza o JSON dos papéis. Devolve { ok: true, politica } ou { ok: false, erros: [...] }.
 * `politica` = { pessoas, papeis, agentes } normalizados. Nunca lança.
 */
function validaPapeis(bruto) {
  const erros = [];
  if (!ehObjeto(bruto)) return { ok: false, erros: ['O arquivo de papéis precisa ser um objeto JSON {"versao":1,"pessoas":{},"papeis":{},"agentes":{}}.'] };
  soChaves(bruto, CAMPOS_RAIZ, 'A raiz', erros);
  if (bruto.versao !== 1) erros.push(`O campo "versao" precisa ser 1 (veio ${JSON.stringify(bruto.versao)}).`);
  const pessoas = {}; const papeis = {}; const agentes = {};

  const bp = bruto.pessoas === undefined ? {} : bruto.pessoas;
  if (!ehObjeto(bp)) erros.push('"pessoas" precisa ser um objeto { "<pessoa>": {...} }.');
  else {
    if (Object.keys(bp).length > MAX_ITENS) erros.push(`"pessoas" tem mais de ${MAX_ITENS} itens.`);
    for (const [nome, p] of Object.entries(bp)) {
      const onde = `pessoas.${String(nome).slice(0, 40)}`;
      if (!nomeValido(nome, 'pessoas', erros)) continue;
      if (!ehObjeto(p)) { erros.push(`${onde} precisa ser um objeto.`); continue; }
      soChaves(p, CAMPOS_PESSOA, onde, erros);
      if (p.nome !== undefined && (typeof p.nome !== 'string' || p.nome.length > 120)) erros.push(`${onde}.nome precisa ser um texto de até 120 caracteres.`);
      pessoas[nome] = { nome: typeof p.nome === 'string' ? p.nome : nome, fontes: normalizaFontes(p.fontes, onde, erros), acoes: normalizaAcoes(p.acoes, onde, erros) };
    }
  }

  const bpa = bruto.papeis === undefined ? {} : bruto.papeis;
  if (!ehObjeto(bpa)) erros.push('"papeis" precisa ser um objeto { "<papel>": {...} }.');
  else {
    if (Object.keys(bpa).length > MAX_ITENS) erros.push(`"papeis" tem mais de ${MAX_ITENS} itens.`);
    for (const [nome, p] of Object.entries(bpa)) {
      const onde = `papeis.${String(nome).slice(0, 40)}`;
      if (!nomeValido(nome, 'papeis', erros)) continue;
      if (!ehObjeto(p)) { erros.push(`${onde} precisa ser um objeto.`); continue; }
      soChaves(p, CAMPOS_PAPEL, onde, erros);
      papeis[nome] = { fontes: normalizaFontes(p.fontes, onde, erros), acoes: normalizaAcoes(p.acoes, onde, erros) };
    }
  }

  const ba = bruto.agentes === undefined ? {} : bruto.agentes;
  if (!ehObjeto(ba)) erros.push('"agentes" precisa ser um objeto { "<slug>": { "pessoa": ..., "papel": ... } }.');
  else {
    if (Object.keys(ba).length > MAX_ITENS) erros.push(`"agentes" tem mais de ${MAX_ITENS} itens.`);
    for (const [slug, a] of Object.entries(ba)) {
      const onde = `agentes.${String(slug).slice(0, 40)}`;
      if (!RX_SLUG.test(slug)) { erros.push(`agentes: o slug "${String(slug).slice(0, 40)}" não vale (minúsculas, números e hífen, até 32 caracteres).`); continue; }
      if (slug === 'admin') { erros.push('agentes: o Admin não entra nos papéis de dados; ele não usa a caixa.'); continue; }
      if (!ehObjeto(a)) { erros.push(`${onde} precisa ser um objeto { "pessoa", "papel" }.`); continue; }
      soChaves(a, CAMPOS_AGENTE, onde, erros);
      if (typeof a.pessoa !== 'string' || !RX_NOME.test(a.pessoa)) erros.push(`${onde}.pessoa é obrigatório e precisa ser o nome de uma pessoa do bloco "pessoas".`);
      else if (ehObjeto(bp) && !bp[a.pessoa]) erros.push(`${onde}.pessoa aponta para "${a.pessoa}", que não existe em "pessoas".`);
      if (typeof a.papel !== 'string' || !RX_NOME.test(a.papel)) erros.push(`${onde}.papel é obrigatório e precisa ser o nome de um papel do bloco "papeis".`);
      else if (ehObjeto(bpa) && !bpa[a.papel]) erros.push(`${onde}.papel aponta para "${a.papel}", que não existe em "papeis".`);
      agentes[slug] = { pessoa: a.pessoa, papel: a.papel };
    }
  }

  if (erros.length) return { ok: false, erros };
  return { ok: true, politica: { pessoas, papeis, agentes } };
}

const VAZIA = Object.freeze({ pessoas: {}, papeis: {}, agentes: {} });

/**
 * Leitor do arquivo de papéis. `estado()` devolve { ok, erro, politica, origem, hash } já atualizado se o
 * arquivo mudou. Com ok:false, `politica` é a vazia (tudo negado) e quem decide tem de negar com `erro`.
 */
function criarPapeis({ caminho, log }) {
  let assinatura = null;
  let estado = { ok: true, erro: null, politica: VAZIA, origem: 'ausente', hash: null };
  let ultimoLog = null;

  function logaUmaVez(nivel, msg) {
    if (ultimoLog === msg) return;
    ultimoLog = msg;
    log(nivel, msg);
  }

  function recarrega() {
    let st;
    try { st = fs.statSync(caminho); } catch (e) {
      if (assinatura === 'ausente') return;
      assinatura = 'ausente';
      estado = { ok: true, erro: null, politica: VAZIA, origem: 'ausente', hash: null };
      logaUmaVez('info', `Papéis de dados: não existe ${caminho} (${e.code || e.name}); nenhum agente alcança fonte alguma até o dono criar o arquivo (rode o instalador ou veja web/docs/DADOS-POR-PAPEL.md).`);
      return;
    }
    // ino e ctime entram na assinatura: uma troca de arquivo que preserve mtime e tamanho (cp -p, touch -d) ainda é vista.
    const nova = `${st.ino}:${st.ctimeMs}:${st.mtimeMs}:${st.size}`;
    if (nova === assinatura) return;
    assinatura = nova;
    let texto;
    try { texto = fs.readFileSync(caminho, 'utf8'); } catch (e) {
      estado = { ok: false, erro: `Não consegui ler o arquivo de papéis ${caminho} (${e.code || e.message}). Enquanto isso todo acesso a dados está negado.`, politica: VAZIA, origem: 'erro', hash: null };
      logaUmaVez('erro', `Papéis de dados: ${estado.erro}`);
      return;
    }
    const hash = crypto.createHash('sha256').update(texto).digest('hex').slice(0, 12);
    let json;
    try { json = JSON.parse(texto); } catch (e) {
      estado = { ok: false, erro: `O arquivo de papéis ${caminho} não é JSON válido (${e.message}). Enquanto isso todo acesso a dados está negado; corrija o arquivo e o Web o relê sozinho.`, politica: VAZIA, origem: 'erro', hash };
      logaUmaVez('erro', `Papéis de dados: ${estado.erro}`);
      return;
    }
    const v = validaPapeis(json);
    if (!v.ok) {
      const lista = v.erros.slice(0, 5).join(' ');
      estado = { ok: false, erro: `O arquivo de papéis ${caminho} tem ${v.erros.length} problema(s): ${lista}${v.erros.length > 5 ? ' (...)' : ''} Enquanto isso todo acesso a dados está negado.`, politica: VAZIA, origem: 'erro', hash };
      logaUmaVez('erro', `Papéis de dados: ${estado.erro}`);
      return;
    }
    estado = { ok: true, erro: null, politica: v.politica, origem: 'arquivo', hash };
    const n = (o) => Object.keys(o).length;
    logaUmaVez('info', `Papéis de dados carregados de ${caminho} (sha256 ${hash}, modificado em ${new Date(st.mtimeMs).toISOString()}): ${n(v.politica.pessoas)} pessoa(s), ${n(v.politica.papeis)} papel(is), ${n(v.politica.agentes)} agente(s).`);
  }

  return {
    estado() { recarrega(); return estado; },
    /** { pessoa, papel } do agente, ou null se não está no arquivo (ou se o arquivo está inválido). */
    deAgente(slug) { recarrega(); return estado.ok ? estado.politica.agentes[slug] || null : null; },
  };
}

module.exports = { validaPapeis, criarPapeis, NIVEIS_FONTE, NIVEIS_ACAO, RX_NOME };
