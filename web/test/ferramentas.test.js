'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validaFerramentas, criarFerramentas } = require('../lib/ferramentas');
const { validaEsquema, validaParams } = require('../lib/dados-fontes/esquema');
const { ErroFonte } = require('../lib/dados-fontes/json');
const { pastaTemp, capturaLog } = require('./ajuda');

const EXEMPLO = {
  versao: 1,
  ferramentas: {
    crm: {
      tipo: 'api', titulo: 'CRM', base_url: 'https://crm.exemplo.test/api/', credencial: 'crm', auth: { tipo: 'bearer' },
      catalogo: { dono: 'comercial', classificacao: 'pessoal', finalidade: 'atendimento', retencao_dias: 0 },
      operacoes: {
        clientes_listar: { metodo: 'GET', rota: '/clientes', escopo: 'crm:ler', params: { q: { tipo: 'texto', max: 100 }, limit: { tipo: 'inteiro', min: 1, max: 200, padrao: 50 } }, campos: ['id', 'nome'] },
        cliente_ler: { metodo: 'GET', rota: '/clientes/{id}', escopo: 'crm:ler', params: { id: { tipo: 'texto', regex: '^[0-9]{1,12}$', obrigatorio: true } } },
        proposta_criar: { metodo: 'POST', rota: '/propostas', escopo: 'crm:escrever', acao: true, params: { cliente_id: { tipo: 'texto', regex: '^[0-9]{1,12}$', obrigatorio: true }, valor: { tipo: 'numero', min: 0 } } },
      },
    },
    vendas: { tipo: 'banco', arquivo: '/var/lib/dgclaw/dados/vendas.sqlite', operacoes: { resumo_mes: { sql: 'SELECT produto, SUM(valor) AS total FROM vendas WHERE mes = :mes GROUP BY produto', escopo: 'vendas:ler', params: { mes: { tipo: 'periodo', obrigatorio: true } } } } },
    notion: { tipo: 'mcp', comando: '/usr/bin/node', args: ['/opt/mcp/notion.js'], credencial: 'notion', credencial_env: 'NOTION_TOKEN', env: { NOTION_VERSAO: '2022' }, operacoes: { buscar: { tool: 'search', escopo: 'notion:ler', params: { query: { tipo: 'texto', obrigatorio: true } } } } },
  },
};

test('validaFerramentas aceita o exemplo e normaliza', () => {
  const r = validaFerramentas(EXEMPLO);
  assert.equal(r.ok, true, JSON.stringify(r.erros));
  assert.equal(r.ferramentas.crm.base_url, 'https://crm.exemplo.test/api');
  assert.deepEqual(r.ferramentas.crm.auth, { tipo: 'bearer', nome: null });
  assert.equal(r.ferramentas.crm.timeout_s, 20);
  assert.equal(r.ferramentas.crm.operacoes.proposta_criar.acao, true);
  assert.equal(r.ferramentas.crm.operacoes.clientes_listar.acao, false);
  assert.deepEqual(r.ferramentas.crm.operacoes.clientes_listar.campos, ['id', 'nome']);
  assert.equal(r.ferramentas.vendas.credencial, null);
  assert.equal(r.ferramentas.notion.credencial_env, 'NOTION_TOKEN');
  assert.equal(r.ferramentas.notion.catalogo.classificacao, 'interno');
});

test('credenciais por escopo: a do escopo vence a padrão; cabecalho_agente e env_agente normalizados', () => {
  const r = validaFerramentas({ versao: 1, ferramentas: {
    crm: { tipo: 'api', base_url: 'https://a.test', auth: { tipo: 'bearer' }, credencial: 'crm-leitura', credenciais: { 'crm:escrever': 'crm-escrita' }, cabecalho_agente: 'X-DGClaw-Agente',
      operacoes: { listar: { metodo: 'GET', rota: '/c', escopo: 'crm:ler' }, criar: { metodo: 'POST', rota: '/c', escopo: 'crm:escrever', acao: true } } },
    so: { tipo: 'api', base_url: 'https://b.test', auth: { tipo: 'bearer' }, credenciais: { 'so:ler': 'so-leitura' }, operacoes: { listar: { metodo: 'GET', rota: '/c', escopo: 'so:ler' } } },
    m: { tipo: 'mcp', comando: '/usr/bin/node', credencial: 'n', credencial_env: 'TOKEN', env_agente: 'DGCLAW_AGENTE', operacoes: { a: { tool: 't', escopo: 'm:ler' } } },
  } });
  assert.equal(r.ok, true, JSON.stringify(r.erros));
  assert.deepEqual(r.ferramentas.crm.credenciais, { 'crm:escrever': 'crm-escrita' }); assert.equal(r.ferramentas.crm.credencial, 'crm-leitura'); assert.equal(r.ferramentas.crm.cabecalho_agente, 'X-DGClaw-Agente');
  assert.equal(r.ferramentas.so.credencial, null); assert.deepEqual(r.ferramentas.so.credenciais, { 'so:ler': 'so-leitura' });
  assert.equal(r.ferramentas.m.env_agente, 'DGCLAW_AGENTE'); assert.equal(r.ferramentas.m.cabecalho_agente, undefined);
  const ok2 = validaFerramentas({ versao: 1, ferramentas: { k: { tipo: 'api', base_url: 'https://a.test', auth: { tipo: 'bearer' }, credencial: 'c', cabecalho_agente: 'X-Keycloak-Agente', operacoes: {} }, m2: { tipo: 'mcp', comando: '/usr/bin/node', env_agente: 'DGCLAW_AGENTE_SLUG', operacoes: {} } } });
  assert.equal(ok2.ok, true, JSON.stringify(ok2.erros));
});

test('validaFerramentas recusa o que abriria uma brecha ou quebraria a chamada', () => {
  const api = (extra, ops) => ({ versao: 1, ferramentas: { x: Object.assign({ tipo: 'api', base_url: 'https://a.test', operacoes: ops || {} }, extra) } });
  const casos = [
    [{ versao: 1, ferramentas: { 'X': { tipo: 'api' } } }, /nome "X" não vale/],
    [{ versao: 1, ferramentas: { x: { tipo: 'ftp' } } }, /tipo precisa ser um de/],
    [api({ base_url: 'http://crm.exemplo.test' }), /http só vale para a própria máquina/],
    [api({ base_url: 'https://u:p@a.test' }), /sem usuário, senha/],
    [api({ base_url: 'https://a.test/?x=1' }), /sem usuário, senha/],
    [api({ auth: { tipo: 'bearer' } }), /exige "credencial"/],
    [api({ credencial: 'c' }), /auth "nenhuma" com "credencial"/],
    [api({ credencial: 'SK_LIVE_abc' }), /NOME de uma credencial/],
    [api({ credencial: 'c', auth: { tipo: 'cabecalho' } }), /precisa de "nome"/],
    [api({ arquivo: '/x.db' }), /campo desconhecido "arquivo"/],
    [api({ timeout_s: 60 }), /timeout_s precisa ser um inteiro de 1 a 25/],
    [api({}, { a: { metodo: 'GET', rota: '/x', escopo: 'crm' } }), /formato "sistema:nivel"/],
    [api({}, { a: { metodo: 'GET', rota: 'x', escopo: 'crm:ler' } }), /rota precisa começar por/],
    [api({}, { a: { metodo: 'GET', rota: '/x?y=1', escopo: 'crm:ler' } }), /rota precisa começar por/],
    [api({}, { a: { metodo: 'GET', rota: '/relatórios', escopo: 'crm:ler' } }), /caractere que a URL codificaria/],
    [api({}, { a: { metodo: 'GET', rota: '/x/"y"', escopo: 'crm:ler' } }), /caractere que a URL codificaria/],
    [api({}, { a: { metodo: 'GET', rota: '/x/{id}', escopo: 'crm:ler' } }), /usa \{id\}, que não está em "params"/],
    [api({}, { a: { metodo: 'GET', rota: '/x/{id}', escopo: 'crm:ler', params: { id: { tipo: 'texto' } } } }), /entra na rota e por isso precisa de "regex"/],
    [api({}, { a: { metodo: 'GET', rota: '/x/{id}', escopo: 'crm:ler', params: { id: { tipo: 'booleano' } } } }), /entra na rota e precisa ser texto com regex/],
    [{ versao: 1, ferramentas: { b: { tipo: 'banco', arquivo: '/x.sqlite', operacoes: { a: { sql: 'SELECT 1', escopo: 'b:ler', params: { q: { tipo: 'texto' } } } } } } }, /"q" não aparece no sql/],
    [api({}, { a: { metodo: 'POST', rota: '/x', escopo: 'crm:ler' } }), /POST escreve no sistema e por isso precisa de "acao": true/],
    [api({}, { a: { metodo: 'GET', rota: '/x', escopo: 'crm:ler', acao: true } }), /GET não pode ser ação/],
    [api({}, { a: { metodo: 'GET', rota: '/x', escopo: 'crm:ler', params: { q: { tipo: 'texto', regex: '(' } } } }), /regex não compila/],
    [api({}, { a: { metodo: 'GET', rota: '/x', escopo: 'crm:ler', params: { 'Q': { tipo: 'texto' } } } }), /nome que não vale/],
    [api({}, { a: { metodo: 'GET', rota: '/x', escopo: 'crm:ler', sql: 'x' } }), /campo desconhecido "sql"/],
    [{ versao: 1, ferramentas: { b: { tipo: 'banco', arquivo: 'rel.db' } } }, /caminho absoluto de um arquivo/],
    [{ versao: 1, ferramentas: { b: { tipo: 'banco', arquivo: '/x.sqlite', operacoes: { a: { sql: 'SELECT 1; DROP TABLE x', escopo: 'b:ler' } } } } }, /não pode ter ";"/],
    [{ versao: 1, ferramentas: { b: { tipo: 'banco', arquivo: '/x.sqlite', operacoes: { a: { sql: 'DELETE FROM x', escopo: 'b:escrever' } } } } }, /não é SELECT\/WITH e por isso precisa de "acao": true/],
    [{ versao: 1, ferramentas: { b: { tipo: 'banco', arquivo: '/x.sqlite', operacoes: { a: { sql: 'SELECT * FROM x WHERE m = :mes', escopo: 'b:ler' } } } } }, /usa :mes, que não está em "params"/],
    [{ versao: 1, ferramentas: { m: { tipo: 'mcp', comando: 'node', operacoes: {} } } }, /caminho absoluto do programa/],
    [{ versao: 1, ferramentas: { m: { tipo: 'mcp', comando: '/usr/bin/node', credencial: 'n', operacoes: {} } } }, /em qual variável ela vai/],
    [{ versao: 1, ferramentas: { m: { tipo: 'mcp', comando: '/usr/bin/node', env: { API_TOKEN: 'x' }, operacoes: {} } } }, /parece ter um segredo/],
    [{ versao: 1, ferramentas: { m: { tipo: 'mcp', comando: '/usr/bin/node', credencial: 'n', credencial_env: 'T', env: { T: 'x' }, operacoes: {} } } }, /não pode definir T/],
    [{ versao: 1, ferramentas: { m: { tipo: 'mcp', comando: '/usr/bin/node', operacoes: { a: { escopo: 'm:ler' } } } } }, /tool é obrigatório/],
    // credencial por escopo
    [api({ auth: { tipo: 'bearer' }, credenciais: { 'crm:ler': 'crm-leitura' } }, { a: { metodo: 'GET', rota: '/x', escopo: 'crm:ler' }, b: { metodo: 'POST', rota: '/x', escopo: 'crm:escrever', acao: true } }), /escopo "crm:escrever" não tem credencial/],
    [api({ auth: { tipo: 'bearer' }, credenciais: { 'crm:ler': 'crm-leitura', 'crm:apagar': 'x' } }, { a: { metodo: 'GET', rota: '/x', escopo: 'crm:ler' } }), /cita o escopo "crm:apagar", que nenhuma operação usa/],
    [api({ auth: { tipo: 'bearer' }, credenciais: { 'crm:ler': 'SK_LIVE_abc' } }, { a: { metodo: 'GET', rota: '/x', escopo: 'crm:ler' } }), /NOME de uma credencial do cofre/],
    [api({ auth: { tipo: 'bearer' }, credenciais: { crm: 'c' } }, { a: { metodo: 'GET', rota: '/x', escopo: 'crm:ler' } }), /escopo "crm" não vale/],
    [api({ credenciais: { 'crm:ler': 'c' } }, { a: { metodo: 'GET', rota: '/x', escopo: 'crm:ler' } }), /auth "nenhuma" com "credencial"/],
    [{ versao: 1, ferramentas: { b: { tipo: 'banco', arquivo: '/x.sqlite', credenciais: { 'b:ler': 'c' }, operacoes: { a: { sql: 'SELECT 1', escopo: 'b:ler' } } } } }, /banco SQLite não usa "credenciais"/],
    [{ versao: 1, ferramentas: { m: { tipo: 'mcp', comando: '/usr/bin/node', credenciais: { 'm:ler': 'n' }, operacoes: { a: { tool: 't', escopo: 'm:ler' } } } } }, /em qual variável ela vai/],
    // o cabeçalho e a variável com o slug do agente
    [api({ auth: { tipo: 'bearer' }, credencial: 'c', cabecalho_agente: 'Authorization' }), /cabecalho_agente precisa ser o nome de um cabeçalho HTTP próprio/],
    [api({ auth: { tipo: 'cabecalho', nome: 'X-Api-Key' }, credencial: 'c', cabecalho_agente: 'x-api-key' }), /cabecalho_agente precisa ser/],
    [api({ auth: { tipo: 'bearer' }, credencial: 'c', cabecalho_agente: 'X Agente' }), /cabecalho_agente precisa ser/],
    [api({ auth: { tipo: 'bearer' }, credencial: 'c', cabecalho_agente: 'X-HTTP-Method-Override' }), /cabecalho_agente precisa ser/],
    [api({ auth: { tipo: 'bearer' }, credencial: 'c', cabecalho_agente: 'X-Forwarded-For' }), /cabecalho_agente precisa ser/],
    [api({ auth: { tipo: 'bearer' }, credencial: 'c', cabecalho_agente: 'Proxy-Authorization' }), /cabecalho_agente precisa ser/],
    [api({ auth: { tipo: 'bearer' }, credencial: 'c', cabecalho_agente: 'Origin' }), /cabecalho_agente precisa ser/],
    [api({ auth: { tipo: 'bearer' }, credencial: 'c', cabecalho_agente: 'X-Api-Key' }), /cabecalho_agente precisa ser/],
    [{ versao: 1, ferramentas: { m: { tipo: 'mcp', comando: '/usr/bin/node', env_agente: 'PATH', operacoes: {} } } }, /env_agente precisa ser/],
    [{ versao: 1, ferramentas: { m: { tipo: 'mcp', comando: '/usr/bin/node', env_agente: 'NODE_COMPILE_CACHE', operacoes: {} } } }, /env_agente precisa ser/],
    [{ versao: 1, ferramentas: { m: { tipo: 'mcp', comando: '/usr/bin/node', env_agente: 'AGENTE', operacoes: {} } } }, /env_agente precisa ser/],
    [api({ auth: { tipo: 'bearer' }, credencial: 'c', cabecalho_agente: 'X-HTTP-Method' }), /cabecalho_agente precisa ser/],
    [api({ auth: { tipo: 'bearer' }, credencial: 'c', cabecalho_agente: 'X-Rewrite-URL' }), /cabecalho_agente precisa ser/],
    [api({ auth: { tipo: 'bearer' }, credencial: 'c', cabecalho_agente: 'X-Vault-Token' }), /cabecalho_agente precisa ser/],
    [api({ auth: { tipo: 'bearer' }, credencial: 'c', cabecalho_agente: 'X-Goog-Api-Key' }), /cabecalho_agente precisa ser/],
    [api({ auth: { tipo: 'bearer' }, credencial: 'c', cabecalho_agente: 'X-Remote-User' }), /cabecalho_agente precisa ser/],
    [api({ auth: { tipo: 'bearer' }, credencial: 'c', cabecalho_agente: 'X-WEBAUTH-USER' }), /cabecalho_agente precisa ser/],
    [api({ auth: { tipo: 'bearer' }, credencial: 'c', cabecalho_agente: 'X-Hub-Signature-256' }), /cabecalho_agente precisa ser/],
    [api({ auth: { tipo: 'bearer' }, credencial: 'c', cabecalho_agente: 'X-Session-Id' }), /cabecalho_agente precisa ser/],
    [api({ auth: { tipo: 'bearer' }, credencial: 'c', cabecalho_agente: 'X-Email' }), /cabecalho_agente precisa ser/],
    [{ versao: 1, ferramentas: { m: { tipo: 'mcp', comando: '/usr/bin/node', env_agente: 'DGCLAW_RAIZ', operacoes: {} } } }, /env_agente precisa ser/],
    [{ versao: 1, ferramentas: { m: { tipo: 'mcp', comando: '/usr/bin/node', env_agente: 'DGCLAW_WEB_DATA', operacoes: {} } } }, /env_agente precisa ser/],
    [{ versao: 1, ferramentas: { m: { tipo: 'mcp', comando: '/usr/bin/node', env_agente: 'LD_PRELOAD', operacoes: {} } } }, /env_agente precisa ser/],
    [{ versao: 1, ferramentas: { m: { tipo: 'mcp', comando: '/usr/bin/node', env_agente: 'NODE_OPTIONS', operacoes: {} } } }, /env_agente precisa ser/],
    [{ versao: 1, ferramentas: { m: { tipo: 'mcp', comando: '/usr/bin/node', env: { EXTRA: 'sim' }, env_agente: 'EXTRA', operacoes: {} } } }, /env_agente precisa ser/],
    [{ versao: 1, ferramentas: { m: { tipo: 'mcp', comando: '/usr/bin/node', credencial: 'n', credencial_env: 'T', env_agente: 'T', operacoes: {} } } }, /env_agente precisa ser/],
    [{ versao: 1, ferramentas: { m: { tipo: 'mcp', comando: '/usr/bin/node', env_agente: 'minuscula', operacoes: {} } } }, /env_agente precisa ser/],
  ];
  for (const [entrada, rx] of casos) {
    const r = validaFerramentas(entrada);
    assert.equal(r.ok, false, JSON.stringify(entrada));
    assert.ok(r.erros.some((e) => rx.test(e)), `esperava ${rx} em ${JSON.stringify(r.erros)}`);
  }
});

test('esquema: valida parâmetros de chamada, preenche padrões e recusa o resto', () => {
  const e = { q: { tipo: 'texto', max: 5, regex: '^[a-z]+$' }, n: { tipo: 'inteiro', min: 1, max: 10, padrao: 3 }, f: { tipo: 'numero' }, b: { tipo: 'booleano' }, t: { tipo: 'enum', valores: ['a', 'b'] }, m: { tipo: 'periodo' }, d: { tipo: 'data' }, o: { tipo: 'texto', obrigatorio: true } };
  assert.equal(validaEsquema(e), null);
  assert.deepEqual(validaParams(e, { o: 'x' }, 'op'), { n: 3, o: 'x' });
  assert.deepEqual(validaParams(e, { o: 'x', q: 'abc', n: 7, f: 1.5, b: true, t: 'b', m: '2026-11', d: '2026-11-08' }, 'op'), { q: 'abc', n: 7, f: 1.5, b: true, t: 'b', m: '2026-11', d: '2026-11-08', o: 'x' });
  const falha = (p, rx) => { try { validaParams(e, p, 'op'); } catch (err) { assert.ok(err instanceof ErroFonte); assert.equal(err.status, 400); assert.match(err.message, rx); return; } assert.fail('devia recusar ' + JSON.stringify(p)); };
  falha({}, /"o" é obrigatório/);
  falha({ o: 'x', zz: 1 }, /"zz" não existe/);
  falha({ o: 'x', q: 'abcdef' }, /máximo é 5/);
  falha({ o: 'x', q: 'AB' }, /formato esperado/);
  falha({ o: 'x', q: 'a​b' }, /invisíveis/);
  falha({ o: 'x', n: 11 }, /no máximo 10/);
  falha({ o: 'x', n: 1.5 }, /inteiro/);
  falha({ o: 'x', f: 'x' }, /número/);
  falha({ o: 'x', b: 'sim' }, /true ou false/);
  falha({ o: 'x', t: 'c' }, /um de: a, b/);
  falha({ o: 'x', m: '2026-13' }, /AAAA-MM/);
  falha({ o: 'x', d: '08/11/2026' }, /AAAA-MM-DD/);
  falha({ o: 1 }, /"o" precisa ser um texto/);
  falha([], /objeto JSON/);
  assert.match(validaEsquema({ a: { tipo: 'enum' } }), /precisa de "valores"/);
  assert.match(validaEsquema({ a: { tipo: 'inteiro', padrao: 'x' } }), /"padrao" não passa/);
  assert.match(validaEsquema({ a: { tipo: 'texto', max: 9999 } }), /"max" precisa ser um inteiro de 1 a 2000/);
});

test('criarFerramentas: ausente é vazio; inválido fecha; corrigir reabre; obter ignora o protótipo', () => {
  const dir = pastaTemp('ferr');
  const arq = path.join(dir, 'ferramentas.json');
  const cap = capturaLog();
  const f = criarFerramentas({ caminho: arq, log: cap.log });
  try {
    assert.equal(f.estado().ok, true); assert.equal(f.obter('crm'), null);
    fs.writeFileSync(arq, '{ nope');
    assert.equal(f.estado().ok, false); assert.match(f.estado().erro, /não é JSON válido/);
    fs.writeFileSync(arq, JSON.stringify(EXEMPLO));
    assert.equal(f.estado().ok, true); assert.equal(f.obter('crm').tipo, 'api'); assert.equal(f.obter('constructor'), null);
    assert.match(cap.texto(), /Ferramentas carregadas .*3 ferramenta\(s\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
