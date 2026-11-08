'use strict';
// Gateway de ferramentas: credencial no cofre de sistemas, adaptadores api/banco/mcp contra dublês locais,
// decisão por escopo e a rota ponta a ponta com aprovação de escrita.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { decidirFerramenta } = require('../lib/dados-decisao');
const { validaPapeis, criarPapeis } = require('../lib/papeis');
const { validaFerramentas, criarFerramentas } = require('../lib/ferramentas');
const { criarCofreSistemas, ErroCredencial } = require('../lib/cofre-sistemas');
const { criarFontes, ErroFonte } = require('../lib/dados-fontes');
const { montaUrl, normalizaResultado, desembrulhaMcp, mascara, mascaraLista, mascaraObjeto } = require('../lib/dados-fontes/ferramenta');
const { criarDados } = require('../lib/dados');
const { pastaTemp, capturaLog } = require('./ajuda');

const souRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const PAPEIS = {
  versao: 1,
  pessoas: {
    marta: { ferramentas: ['crm:ler', 'crm:escrever', 'vendas:ler', 'notas:ler'] },
    caio: { ferramentas: ['crm:ler'] },
    lia: { estado: 'desligada', ferramentas: ['*'] },
  },
  papeis: {
    vendedor: { ferramentas: ['crm:ler', 'crm:escrever', 'vendas:ler', 'notas:ler'] },
    analista: { ferramentas: ['*'] },
  },
  agentes: { ana: { pessoa: 'marta', papel: 'vendedor' }, bia: { pessoa: 'caio', papel: 'analista' }, duda: { pessoa: 'lia', papel: 'analista' } },
};

/** API falsa do CRM: exige o bearer, registra as chamadas, devolve clientes e aceita propostas. */
async function crmFalso() {
  const chamadas = [];
  const srv = http.createServer((req, res) => {
    const partes = []; req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      const corpo = Buffer.concat(partes).toString('utf8');
      chamadas.push({ metodo: req.method, url: req.url, auth: req.headers.authorization || null, agente: req.headers['x-dgclaw-agente'] || null, corpo });
      const j = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (!['Bearer segredo-do-crm-123', 'Bearer so-leitura-456', 'Bearer leitura-e-escrita-789'].includes(req.headers.authorization)) return j(401, { erro: 'sem credencial' });
      if (req.headers.authorization === 'Bearer so-leitura-456' && req.method !== 'GET') return j(403, { erro: 'chave só de leitura' });
      if (req.method === 'GET' && req.url.startsWith('/api/clientes/')) return j(200, { id: req.url.split('/').pop(), nome: 'Cliente Exemplo', cpf: 'oculto?' });
      if (req.url === '/api/conta') return j(200, { chaves: ['so-leitura-456', 'leitura-e-escrita-789'], dica: 'leitura-e-escrita-789' });
      if (req.method === 'GET' && req.url.startsWith('/api/clientes')) return j(200, { items: [{ id: '1', nome: 'Um', cpf: '000' }, { id: '2', nome: 'Dois', cpf: '111' }] });
      if (req.method === 'POST' && req.url === '/api/propostas') return j(201, { id: 'p9', recebido: JSON.parse(corpo) });
      if (req.url === '/api/redireciona') { res.writeHead(302, { Location: 'http://127.0.0.1:1/x' }); return res.end(); }
      if (req.url === '/api/texto') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('não é json'); }
      if (req.url === '/api/lento') return setTimeout(() => j(200, {}), 3000);
      if (req.url === '/api/goteja') { res.writeHead(200, { 'content-type': 'application/json' }); let n = 0; const t = setInterval(() => { res.write('x'); if (++n > 12) { clearInterval(t); res.end(); } }, 300); return; }
      if (req.url === '/api/ecoa') return j(422, { erro: 'cabeçalho recebido: ' + req.headers.authorization });
      j(404, { erro: 'rota' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { chamadas, porta: srv.address().port, fechar: () => new Promise((r) => srv.close(r)) };
}

function cofreDeTeste(base) {
  const dir = path.join(base, 'cofre-sistemas');
  fs.mkdirSync(dir, { mode: 0o700 });
  const grava = (nome, valor, modo) => { fs.writeFileSync(path.join(dir, nome), valor, { mode: modo || 0o600 }); };
  return { dir, grava, cofre: criarCofreSistemas({ dir }) };
}

test('cofre de sistemas: lê só arquivo comum de root com 600; erros nunca trazem o valor', () => {
  const base = pastaTemp('cofre-s');
  const { dir, grava, cofre } = cofreDeTeste(base);
  try {
    grava('crm', 'segredo-do-crm-123\n');
    assert.equal(cofre.ler('crm'), 'segredo-do-crm-123');
    assert.deepEqual(cofre.nomes(), ['crm']);
    const lanca = (nome, codigo, rx) => { try { cofre.ler(nome); } catch (e) { assert.ok(e instanceof ErroCredencial); assert.equal(e.code, codigo, e.message); assert.ok(!e.message.includes('segredo-do-crm'), 'valor nunca na mensagem'); if (rx) assert.match(e.message, rx); return; } assert.fail('devia lançar ' + nome); };
    lanca('nada', 'AUSENTE', /dgclaw sistema credencial nada/);
    lanca('Crm', 'NOME');
    lanca('../etc/passwd', 'NOME');
    grava('aberto', 'x', 0o644); lanca('aberto', 'MODO', /chmod 600/);
    fs.symlinkSync(path.join(dir, 'crm'), path.join(dir, 'atalho')); lanca('atalho', 'ATALHO');
    grava('vazio', '\n'); lanca('vazio', 'VAZIA');
    grava('grande', 'x'.repeat(9000)); lanca('grande', 'TAMANHO');
    if (souRoot) { grava('outro', 'x'); fs.chownSync(path.join(dir, 'outro'), 65534, 65534); lanca('outro', 'DONO'); }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('decidirFerramenta: escopo na pessoa E no papel; "*" vale; ação vira aprovação; desligada e desconhecidos negam', () => {
  const pol = { ok: true, politica: validaPapeis(PAPEIS).politica };
  const cat = validaFerramentas({ versao: 1, ferramentas: {
    crm: { tipo: 'api', base_url: 'https://a.test', credencial: 'crm', auth: { tipo: 'bearer' }, operacoes: { listar: { metodo: 'GET', rota: '/c', escopo: 'crm:ler' }, criar: { metodo: 'POST', rota: '/c', escopo: 'crm:escrever', acao: true }, apagar: { metodo: 'DELETE', rota: '/c', escopo: 'crm:apagar', acao: true } } },
  } }).ferramentas;
  const d = (slug, op) => decidirFerramenta({ estado: pol, slug, ferramenta: cat.crm, nomeFerramenta: 'crm', operacao: op });
  assert.equal(d('ana', 'listar').decisao, 'permitido'); assert.equal(d('ana', 'listar').escopo, 'crm:ler');
  assert.equal(d('ana', 'criar').decisao, 'aprovacao');
  let r = d('ana', 'apagar'); assert.equal(r.decisao, 'negado'); assert.match(r.motivo, /pessoa marta não tem o escopo "crm:apagar"/);
  assert.equal(d('bia', 'listar').decisao, 'permitido', 'papel com * e pessoa com crm:ler');
  r = d('bia', 'criar'); assert.equal(r.decisao, 'negado'); assert.match(r.motivo, /pessoa caio não tem o escopo "crm:escrever"/);
  r = d('duda', 'listar'); assert.equal(r.decisao, 'negado'); assert.match(r.motivo, /desligada/);
  r = d('ana', 'nada'); assert.equal(r.decisao, 'negado'); assert.match(r.motivo, /não tem a operação "nada"/);
  assert.equal(d('zed', 'listar').decisao, 'negado');
  assert.equal(decidirFerramenta({ estado: pol, slug: 'ana', ferramenta: null, nomeFerramenta: 'x', operacao: 'listar' }).decisao, 'negado');
  assert.equal(d('ana', 'constructor').decisao, 'negado');
  assert.equal(decidirFerramenta(null).decisao, 'negado');
});

test('montaUrl, normalizaResultado e desembrulhaMcp', () => {
  const f = { base_url: 'https://a.test/api' };
  let u = montaUrl(f, { metodo: 'GET', rota: '/clientes/{id}/notas' }, { id: 'a b&c', limit: 5 });
  assert.equal(u.url.toString(), 'https://a.test/api/clientes/a%20b%26c/notas?limit=5'); assert.equal(u.corpo, null);
  // o que entra na rota nunca muda o caminho: vazio, ".", "..", barra, "?" e "#" são recusados no gateway, com ou sem regex no catálogo
  for (const ruim of ['', '.', '..', '...', 'a/b', 'a?b', 'a#b', '../x']) {
    assert.throws(() => montaUrl(f, { metodo: 'GET', rota: '/clientes/{id}' }, { id: ruim }), (e) => e instanceof ErroFonte && e.status === 400, JSON.stringify(ruim));
  }
  assert.equal(montaUrl({ base_url: 'https://a.test/api' }, { metodo: 'DELETE', rota: '/itens/{id}' }, { id: '42' }).url.pathname, '/api/itens/42');
  u = montaUrl(f, { metodo: 'POST', rota: '/x' }, { a: 1, b: 'y' });
  assert.equal(u.url.toString(), 'https://a.test/api/x'); assert.deepEqual(u.corpo, { a: 1, b: 'y' });
  assert.deepEqual(normalizaResultado([{ a: 1, b: 2 }, { a: 3 }], { campos: ['a'], max_itens: 1 }), { itens: [{ a: 1 }], total: 2, truncado: true });
  assert.deepEqual(normalizaResultado({ data: [{ x: 1 }] }, {}), { itens: [{ x: 1 }], total: 1, truncado: false });
  assert.deepEqual(normalizaResultado({ x: 1, y: 2 }, { campos: ['y'] }), { item: { y: 2 } });
  assert.equal(mascara('Basic dXNlcjpwYXNz e user%3Apass e user:pass', 'user:pass'), 'Basic *** e *** e ***', 'máscara cobre base64 e a forma codificada');
  assert.equal(mascaraLista('chave-maior e chave', ['chave', 'chave-maior']), '*** e ***', 'a mais longa primeiro: o prefixo comum não deixa o resto à mostra');
  // credencial só de dígitos não quebra números; credencial com aspas ou barra é mascarada crua; chaves também
  assert.deepEqual(mascaraObjeto({ item: { id: 7391, ano: 2026, ok: true, nota: 'chave 7391 aqui' } }, '7391'), { item: { id: 7391, ano: 2026, ok: true, nota: 'chave *** aqui' } });
  assert.deepEqual(mascaraObjeto({ itens: [{ s: 'x ab"cd y', 'ab"cd': 1 }], n: null }, 'ab"cd'), { itens: [{ s: 'x *** y', '***': 1 }], n: null });
  assert.deepEqual(mascaraObjeto({ s: 'x ab\\cd y' }, 'ab\\cd'), { s: 'x *** y' });
  assert.deepEqual(desembrulhaMcp({ content: [{ type: 'text', text: '{"a":1}' }] }), { a: 1 });
  assert.deepEqual(desembrulhaMcp({ content: [{ type: 'text', text: 'oi' }] }), { texto: 'oi' });
  assert.deepEqual(desembrulhaMcp({ structuredContent: { z: 1 }, content: [] }), { z: 1 });
  assert.throws(() => desembrulhaMcp({ isError: true, content: [{ type: 'text', text: 'falhou' }] }), ErroFonte);
});

/** Mini-servidor com a rota de dados, o CRM falso, um SQLite e um MCP falso. */
async function subir() {
  const base = pastaTemp('rferr');
  const dir = path.join(base, 'dados');
  const crm = await crmFalso();
  const { grava, cofre } = cofreDeTeste(base);
  grava('crm', 'segredo-do-crm-123');
  grava('notas', 'token-notas-xyz');
  grava('crm-leitura', 'so-leitura-456');
  grava('crm-escrita', 'leitura-e-escrita-789');
  // banco
  const { DatabaseSync } = require('node:sqlite');
  const arqDb = path.join(base, 'vendas.sqlite');
  const db = new DatabaseSync(arqDb);
  db.exec("CREATE TABLE vendas (mes TEXT, produto TEXT, valor REAL); INSERT INTO vendas VALUES ('2026-10','a',10),('2026-10','a',5),('2026-10','b',7),('2026-11','a',1)");
  db.close();
  // MCP falso: responde initialize e tools/call ecoando os argumentos e a credencial que recebeu no ambiente
  const mcp = path.join(base, 'mcp-falso.js');
  fs.writeFileSync(mcp, `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', (l) => { let m; try { m = JSON.parse(l); } catch (_) { return; }
      if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'falso', version: '1' } } }) + '\\n');
      else if (m.method === 'tools/call') {
        if (m.params.name === 'explode') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'tool explodiu' } }) + '\\n');
        else if (m.params.name === 'trava') { setInterval(() => {}, 1000); return; }
        else if (m.params.name === 'morre') { process.stderr.write('ENV-DEBUG NOTAS_TOKEN=' + process.env.NOTAS_TOKEN + '\\n'); process.exit(3); }
        else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ tool: m.params.name, args: m.params.arguments, token: process.env.NOTAS_TOKEN || null, token_len: (process.env.NOTAS_TOKEN || '').length, extra: process.env.EXTRA || null, home: process.env.HOME || null, agente: process.env.DGCLAW_AGENTE || null }) }] } }) + '\\n');
      } });
  `);
  const ferramentas = { versao: 1, ferramentas: {
    crm: { tipo: 'api', titulo: 'CRM de teste', base_url: `http://127.0.0.1:${crm.porta}/api`, credencial: 'crm', auth: { tipo: 'bearer' }, timeout_s: 1,
      catalogo: { dono: 'comercial', classificacao: 'pessoal' },
      operacoes: {
        clientes_listar: { metodo: 'GET', rota: '/clientes', escopo: 'crm:ler', params: { q: { tipo: 'texto', max: 50 } }, campos: ['id', 'nome'] },
        cliente_ler: { metodo: 'GET', rota: '/clientes/{id}', escopo: 'crm:ler', params: { id: { tipo: 'texto', regex: '^[0-9]{1,6}$', obrigatorio: true } }, campos: ['id', 'nome'] },
        proposta_criar: { metodo: 'POST', rota: '/propostas', escopo: 'crm:escrever', acao: true, params: { cliente_id: { tipo: 'texto', regex: '^[0-9]{1,6}$', obrigatorio: true }, valor: { tipo: 'numero', min: 0, obrigatorio: true } } },
        redireciona: { metodo: 'GET', rota: '/redireciona', escopo: 'crm:ler' },
        texto: { metodo: 'GET', rota: '/texto', escopo: 'crm:ler' },
        lento: { metodo: 'GET', rota: '/lento', escopo: 'crm:ler' },
        goteja: { metodo: 'GET', rota: '/goteja', escopo: 'crm:ler' },
        ecoa: { metodo: 'GET', rota: '/ecoa', escopo: 'crm:ler' },
      } },
    vendas: { tipo: 'banco', arquivo: arqDb, operacoes: {
      resumo_mes: { sql: 'SELECT produto, SUM(valor) AS total FROM vendas WHERE mes = :mes GROUP BY produto ORDER BY produto', escopo: 'vendas:ler', params: { mes: { tipo: 'periodo', obrigatorio: true } } },
      apagar_mes: { sql: 'DELETE FROM vendas WHERE mes = :mes', escopo: 'vendas:escrever', acao: true, params: { mes: { tipo: 'periodo', obrigatorio: true } } },
      lenta: { sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 40000000) SELECT COUNT(*) AS n FROM c', escopo: 'vendas:ler' },
      escreve_lenta: { sql: "INSERT INTO vendas SELECT 'marca', 'x', (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 40000000) SELECT COUNT(*) FROM c)", escopo: 'vendas:escrever', acao: true },
      conta_marcas: { sql: "SELECT COUNT(*) AS n FROM vendas WHERE mes = 'marca'", escopo: 'vendas:ler' },
    }, timeout_s: 1 },
    wrapper: { tipo: 'mcp', comando: '/bin/sh', args: ['-c', `echo $$ > ${JSON.stringify(path.join(base, 'mcp-pid'))}; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mcp)}`], credencial: 'notas', credencial_env: 'NOTAS_TOKEN', timeout_s: 1, operacoes: {
      trava: { tool: 'trava', escopo: 'notas:ler' },
      morre: { tool: 'morre', escopo: 'notas:ler' },
    } },
    crm2: { tipo: 'api', titulo: 'CRM com duas chaves', base_url: `http://127.0.0.1:${crm.porta}/api`, auth: { tipo: 'bearer' }, timeout_s: 1, cabecalho_agente: 'X-DGClaw-Agente',
      credenciais: { 'crm2:ler': 'crm-leitura', 'crm2:escrever': 'crm-escrita' },
      operacoes: {
        clientes_listar: { metodo: 'GET', rota: '/clientes', escopo: 'crm2:ler', campos: ['id', 'nome'] },
        conta: { metodo: 'GET', rota: '/conta', escopo: 'crm2:ler' },
        proposta_criar: { metodo: 'POST', rota: '/propostas', escopo: 'crm2:escrever', acao: true, params: { cliente_id: { tipo: 'texto', regex: '^[0-9]{1,6}$', obrigatorio: true }, valor: { tipo: 'numero', min: 0, obrigatorio: true } } },
      } },
    notas: { tipo: 'mcp', comando: process.execPath, args: [mcp], credencial: 'notas', credencial_env: 'NOTAS_TOKEN', env_agente: 'DGCLAW_AGENTE', env: { EXTRA: 'sim' }, timeout_s: 5, operacoes: {
      buscar: { tool: 'search', escopo: 'notas:ler', params: { query: { tipo: 'texto', obrigatorio: true } } },
      explode: { tool: 'explode', escopo: 'notas:ler' },
    } },
  } };
  const arqPapeis = path.join(base, 'papeis.json'); fs.writeFileSync(arqPapeis, JSON.stringify(PAPEIS));
  const arqFerr = path.join(base, 'ferramentas.json'); fs.writeFileSync(arqFerr, JSON.stringify(ferramentas));
  const cap = capturaLog();
  const relogio = { t: Date.UTC(2026, 10, 8, 12, 0, 0) };
  const dados = criarDados({ dir, papeis: criarPapeis({ caminho: arqPapeis, log: cap.log }), ferramentas: criarFerramentas({ caminho: arqFerr, log: cap.log }), cofreSistemas: cofre, push: null, log: cap.log, agora: () => relogio.t });
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const sessao = JSON.parse(req.headers['x-sessao'] || '{"usuario":"dono"}');
    if (!await dados.rotas(req, res, url, sessao)) { res.writeHead(418); res.end('fora'); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const porta = srv.address().port;
  const pedir = (metodo, caminho, corpo, sessao) => new Promise((resolve, reject) => {
    const headers = { 'x-sessao': JSON.stringify(sessao || { usuario: 'dono' }) };
    let txt; if (corpo !== undefined) { txt = JSON.stringify(corpo); headers['content-type'] = 'application/json'; }
    const rq = http.request({ host: '127.0.0.1', port: porta, method: metodo, path: caminho, headers }, (res) => {
      const p = []; res.on('data', (c) => p.push(c));
      res.on('end', () => { const texto = Buffer.concat(p).toString('utf8'); let json = null; try { json = JSON.parse(texto); } catch (_) { /* texto */ } resolve({ status: res.statusCode, texto, json }); });
    });
    rq.on('error', reject); if (txt) rq.write(txt); rq.end();
  });
  return { dados, pedir, crm, arqDb, arqPapeis, base, cap, fechar: async () => { srv.close(); await crm.fechar(); fs.rmSync(base, { recursive: true, force: true }); } };
}
const CAIXA = (slug) => ({ usuario: 'agente:' + slug, via: 'caixa', agente: slug });
const DONO = { usuario: 'dono' };

test('API: a credencial sai do cofre para o cabeçalho e nunca para o agente; campos filtrados; redirecionamento, texto e demora são 502/504', async () => {
  const s = await subir();
  try {
    const f = await s.pedir('GET', '/api/v1/dados/fontes', undefined, CAIXA('ana'));
    const crm = f.json.fontes.find((x) => x.nome === 'ferramenta-crm');
    assert.deepEqual(crm.operacoes.sort(), ['cliente_ler', 'clientes_listar', 'ecoa', 'goteja', 'lento', 'redireciona', 'texto']);
    assert.deepEqual(crm.acoes, { proposta_criar: 'ferramenta:proposta_criar' });
    assert.equal(crm.operacoes_detalhe.cliente_ler.params.id.regex, '^[0-9]{1,6}$');
    assert.ok(!JSON.stringify(f.json).includes('segredo-do-crm'));
    const r = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/clientes_listar', { q: 'um' }, CAIXA('ana'));
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json.itens, [{ id: '1', nome: 'Um' }, { id: '2', nome: 'Dois' }]);
    assert.equal(r.json.escopo, 'crm:ler'); assert.equal(r.json.confianca, 'nao_confiavel');
    assert.ok(!r.texto.includes('cpf') && !r.texto.includes('segredo'));
    assert.equal(s.crm.chamadas[0].auth, 'Bearer segredo-do-crm-123'); assert.equal(s.crm.chamadas[0].url, '/api/clientes?q=um');
    const l = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/cliente_ler', { id: '42' }, CAIXA('ana'));
    assert.deepEqual(l.json.item, { id: '42', nome: 'Cliente Exemplo' });
    assert.equal((await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/cliente_ler', { id: '../x' }, CAIXA('ana'))).status, 400);
    assert.equal((await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/cliente_ler', { id: '1', agente: 'bia' }, CAIXA('ana'))).status, 400);
    assert.equal((await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/clientes_listar', { zz: 1 }, CAIXA('ana'))).status, 400);
    const red = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/redireciona', {}, CAIXA('ana'));
    assert.equal(red.status, 502); assert.match(red.json.erro, /redirecionamento/);
    const tx = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/texto', {}, CAIXA('ana'));
    assert.equal(tx.status, 502); assert.match(tx.json.erro, /só repassa JSON/);
    const le = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/lento', {}, CAIXA('ana'));
    assert.equal(le.status, 504); assert.match(le.json.erro, /não respondeu em 1 s/);
    // um sistema que goteja bytes também cai no prazo total (não só na inatividade)
    const go = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/goteja', {}, CAIXA('ana'));
    assert.equal(go.status, 504);
    // o corpo do erro do sistema (que ecoa o Authorization) nunca chega ao agente; no log do Web vai mascarado
    const ec = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/ecoa', {}, CAIXA('ana'));
    assert.equal(ec.status, 502); assert.ok(!ec.texto.includes('segredo') && !ec.texto.includes('Bearer'), ec.texto);
    assert.match(s.cap.texto(), /respondeu 422: .*Bearer \*\*\*/); assert.ok(!s.cap.texto().includes('segredo-do-crm'));
    // operação que não existe: a dica lista só o que o agente alcança
    const inex = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/nada', {}, CAIXA('bia'));
    assert.equal(inex.status, 404); assert.ok(!inex.json.erro.includes('proposta_criar'), inex.json.erro);
    // caio tem crm:ler; bia (caio) lê, mas não cria
    assert.equal((await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/clientes_listar', {}, CAIXA('bia'))).status, 200);
    const nb = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/proposta_criar', { cliente_id: '1', valor: 10 }, CAIXA('bia'));
    assert.equal(nb.status, 403); assert.match(nb.json.erro, /caio não tem o escopo "crm:escrever"/);
    assert.equal((await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/clientes_listar', {}, CAIXA('duda'))).status, 403);
    // o log tem escopo e nunca a credencial
    const linhas = s.dados.acessos.ultimas(100);
    assert.equal(linhas.find((l) => l.operacao === 'clientes_listar' && l.agente === 'ana').escopo, 'crm:ler');
    assert.ok(!JSON.stringify(linhas).includes('segredo-do-crm'));
  } finally { await s.fechar(); }
});

test('API: escrita só por aprovação; o Web executa com os parâmetros congelados; credencial ausente é 503 sem valor', async () => {
  const s = await subir();
  try {
    const e = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/proposta_criar', { cliente_id: '7', valor: 99.9 }, CAIXA('ana'));
    assert.equal(e.status, 202, e.texto); assert.match(e.json.pedido.descricao, /executar "proposta_criar" no sistema crm com 2 parâmetro\(s\): cliente_id="7", valor=99.9/);
    assert.equal(s.crm.chamadas.filter((c) => c.method === 'POST').length, 0);
    const hash = (await s.pedir('GET', '/api/v1/dados/aprovacoes?estado=pendente', undefined, DONO)).json.aprovacoes[0].hash;
    const a = await s.pedir('POST', `/api/v1/dados/aprovacoes/${e.json.pedido.id}/aprovar`, { hash }, DONO);
    assert.equal(a.status, 200, a.texto); assert.equal(a.json.pedido.estado, 'executada');
    assert.deepEqual(a.json.pedido.resultado.item.recebido, { cliente_id: '7', valor: 99.9 });
    const post = s.crm.chamadas.find((c) => c.metodo === 'POST');
    assert.equal(post.auth, 'Bearer segredo-do-crm-123'); assert.equal(post.corpo, '{"cliente_id":"7","valor":99.9}');
    // o agente vê o resultado, sem o login do dono
    const v = await s.pedir('GET', `/api/v1/dados/pedidos/${e.json.pedido.id}`, undefined, CAIXA('ana'));
    assert.equal(v.json.pedido.estado, 'executada'); assert.equal(v.json.pedido.decidido_por, 'dono');
    // parâmetros inválidos nunca viram pedido
    assert.equal((await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/proposta_criar', { cliente_id: '7' }, CAIXA('ana'))).status, 400);
    // credencial sumiu do cofre: 503, sem valor, e a ação aprovada fica como falhou
    fs.unlinkSync(path.join(path.dirname(s.arqPapeis), 'cofre-sistemas', 'crm'));
    const semCred = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/clientes_listar', {}, CAIXA('ana'));
    assert.equal(semCred.status, 503); assert.match(semCred.json.erro, /não está no cofre de sistemas/);
    const e2 = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/proposta_criar', { cliente_id: '8', valor: 1 }, CAIXA('ana'));
    const hash2 = (await s.pedir('GET', '/api/v1/dados/aprovacoes?estado=pendente', undefined, DONO)).json.aprovacoes[0].hash;
    const a2 = await s.pedir('POST', `/api/v1/dados/aprovacoes/${e2.json.pedido.id}/aprovar`, { hash: hash2 }, DONO);
    assert.equal(a2.json.pedido.estado, 'falhou'); assert.match(a2.json.pedido.motivo, /cofre de sistemas/);
  } finally { await s.fechar(); }
});

test('banco SQLite: consulta parametrizada só leitura; escrita só por aprovação; nome de parâmetro fora do esquema é recusado', async () => {
  const s = await subir();
  try {
    const r = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-vendas/resumo_mes', { mes: '2026-10' }, CAIXA('ana'));
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json.itens, [{ produto: 'a', total: 15 }, { produto: 'b', total: 7 }]);
    assert.equal((await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-vendas/resumo_mes', { mes: "2026-10' OR 1=1 --" }, CAIXA('ana'))).status, 400);
    // ana não tem vendas:escrever
    assert.equal((await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-vendas/apagar_mes', { mes: '2026-10' }, CAIXA('ana'))).status, 403);
    // bia (papel *, pessoa só crm:ler) não tem escopo nenhum em vendas: para ela a ferramenta não existe
    assert.equal((await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-vendas/resumo_mes', { mes: '2026-10' }, CAIXA('bia'))).status, 404);
    assert.equal((await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-vendas/nada', {}, CAIXA('bia'))).status, 404);
    // consulta pesada passa do prazo: o worker é encerrado e o Web continua de pé
    const lenta = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-vendas/lenta', {}, CAIXA('ana'));
    assert.equal(lenta.status, 504, lenta.texto); assert.match(lenta.json.erro, /não terminou em 1 s/);
    // escrita lenta aprovada pelo dono: o prazo estoura, o processo é morto e a linha NÃO fica gravada
    const el = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-vendas/escreve_lenta', {}, DONO);
    assert.equal(el.status, 202, el.texto);
    const hl = (await s.pedir('GET', '/api/v1/dados/aprovacoes?estado=pendente', undefined, DONO)).json.aprovacoes[0].hash;
    const al = await s.pedir('POST', `/api/v1/dados/aprovacoes/${el.json.pedido.id}/aprovar`, { hash: hl }, DONO);
    assert.equal(al.json.pedido.estado, 'falhou'); assert.match(al.json.pedido.motivo, /interrompida/);
    await new Promise((r) => setTimeout(r, 500));
    const conta = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-vendas/conta_marcas', {}, DONO);
    assert.deepEqual(conta.json.itens, [{ n: 0 }], 'a escrita interrompida foi desfeita');
    assert.ok(!s.cap.texto().includes('ExperimentalWarning'), 'sem o aviso experimental do sqlite no log');
    assert.equal((await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-vendas/resumo_mes', { mes: '2026-10' }, CAIXA('ana'))).status, 200, 'o Web responde logo depois');
    // o dono pede a escrita, aprova e o banco muda
    const e = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-vendas/apagar_mes', { mes: '2026-11' }, DONO);
    assert.equal(e.status, 202, e.texto);
    const hash = (await s.pedir('GET', '/api/v1/dados/aprovacoes?estado=pendente', undefined, DONO)).json.aprovacoes[0].hash;
    const a = await s.pedir('POST', `/api/v1/dados/aprovacoes/${e.json.pedido.id}/aprovar`, { hash }, DONO);
    assert.equal(a.status, 200, a.texto); assert.deepEqual(a.json.pedido.resultado.item, { alteradas: 1 });
    assert.deepEqual((await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-vendas/resumo_mes', { mes: '2026-11' }, DONO)).json.itens, []);
  } finally { await s.fechar(); }
});

test('MCP: o servidor nasce com ambiente limpo mais a credencial na variável combinada; erro da tool vira 502', async () => {
  const s = await subir();
  try {
    const r = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-notas/buscar', { query: 'reunião' }, CAIXA('ana'));
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json.item, { tool: 'search', args: { query: 'reunião' }, token: '***', token_len: 15, extra: 'sim', home: null, agente: 'ana' }, 'a credencial chegou ao servidor (15 caracteres), o eco dela sai mascarado, e o servidor sabe qual agente chamou');
    assert.ok(!r.texto.includes('NOTAS_TOKEN=') );
    const x = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-notas/explode', {}, CAIXA('ana'));
    assert.equal(x.status, 502); assert.ok(!x.json.erro.includes('tool explodiu'), 'o detalhe do erro do servidor não chega ao agente'); assert.match(s.cap.texto(), /tool explodiu/);
    // um servidor que ecoa a credencial no resultado: a máscara segura
    const eco = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-notas/buscar', { query: 'ecoa' }, CAIXA('ana'));
    assert.equal(eco.status, 200); assert.equal(eco.json.item.token, '***');
    assert.equal((await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-notas/buscar', { query: 'x' }, CAIXA('bia'))).status, 404, 'sem escopo nenhum, a ferramenta não existe para bia');
    // servidor atrás de um wrapper (sh -c) que não responde: 504, e o neto morre junto (a credencial não fica num processo órfão)
    const tr = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-wrapper/trava', {}, CAIXA('ana'));
    assert.equal(tr.status, 504, tr.texto);
    await new Promise((r) => setTimeout(r, 2600));
    const pid = Number(fs.readFileSync(path.join(s.base, 'mcp-pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), 'o servidor MCP neto foi encerrado');
    // stderr do servidor que encerra não chega ao agente
    const morto = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-wrapper/morre', {}, CAIXA('ana'));
    assert.equal(morto.status, 502); assert.ok(!morto.texto.includes('token-notas'), morto.texto); assert.ok(!morto.texto.includes('ENV-DEBUG'));
    assert.match(s.cap.texto(), /stderr: .*ENV-DEBUG/); assert.ok(!s.cap.texto().includes('token-notas-xyz'));
    const cat = await s.pedir('GET', '/api/v1/dados/ferramentas', undefined, DONO);
    assert.equal(cat.json.valido, true); assert.deepEqual(Object.keys(cat.json.ferramentas).sort(), ['crm', 'crm2', 'notas', 'vendas', 'wrapper']); assert.deepEqual(cat.json.credenciais, ['crm', 'crm-escrita', 'crm-leitura', 'notas']);
    assert.ok(!cat.texto.includes('segredo-do-crm') && !cat.texto.includes('token-notas'));
    assert.equal((await s.pedir('GET', '/api/v1/dados/ferramentas', undefined, CAIXA('ana'))).status, 403);
  } finally { await s.fechar(); }
});

test('credencial por escopo: ler usa a chave de leitura, escrever usa a outra; o sistema sabe qual agente chamou; o log tem o nome da credencial', async () => {
  const s = await subir();
  try {
    // marta e o papel têm crm2:ler e crm2:escrever? dê os escopos pela política
    const pol = JSON.parse(fs.readFileSync(s.arqPapeis, 'utf8'));
    pol.pessoas.marta.ferramentas = ['crm:ler', 'crm:escrever', 'vendas:ler', 'vendas:escrever', 'notas:ler', 'crm2:ler', 'crm2:escrever'];
    pol.papeis.vendedor.ferramentas = pol.pessoas.marta.ferramentas.slice();
    fs.writeFileSync(s.arqPapeis, JSON.stringify(pol));
    const r = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm2/clientes_listar', {}, CAIXA('ana'));
    assert.equal(r.status, 200, r.texto);
    const lida = s.crm.chamadas[s.crm.chamadas.length - 1];
    assert.equal(lida.auth, 'Bearer so-leitura-456', 'a leitura foi com a chave só de leitura');
    assert.equal(lida.agente, 'ana', 'o CRM recebeu o slug do agente no cabeçalho combinado');
    assert.ok(!r.texto.includes('so-leitura-456'));
    const e = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm2/proposta_criar', { cliente_id: '7', valor: 10 }, CAIXA('ana'));
    assert.equal(e.status, 202, e.texto);
    const hash = (await s.pedir('GET', '/api/v1/dados/aprovacoes?estado=pendente', undefined, DONO)).json.aprovacoes.find((x) => x.id === e.json.pedido.id).hash;
    const a = await s.pedir('POST', `/api/v1/dados/aprovacoes/${e.json.pedido.id}/aprovar`, { hash }, DONO);
    assert.equal(a.status, 200, a.texto); assert.equal(a.json.pedido.estado, 'executada', JSON.stringify(a.json.pedido));
    const escrita = s.crm.chamadas[s.crm.chamadas.length - 1];
    assert.equal(escrita.auth, 'Bearer leitura-e-escrita-789', 'a escrita foi com a chave de escrita');
    assert.equal(escrita.agente, 'ana', 'na execução aprovada o agente de origem continua sendo o do pedido');
    // observabilidade por agente: o log diz qual credencial (pelo nome) e o resumo agrupa por agente e sistema
    const linhas = s.dados.acessos.ultimas(100);
    assert.equal(linhas.find((l) => l.fonte === 'ferramenta-crm2' && l.operacao === 'clientes_listar').credencial, 'crm-leitura');
    assert.equal(linhas.find((l) => l.fonte === 'ferramenta-crm2' && l.decisao === 'executada').credencial, 'crm-escrita');
    assert.ok(!JSON.stringify(linhas).includes('so-leitura-456') && !JSON.stringify(linhas).includes('leitura-e-escrita-789'));
    const resumo = s.dados.acessos.resumo('2026-11-01');
    assert.equal(resumo.por_agente_sistema['ana › crm2 (crm2:ler)'], 1);
    assert.ok(resumo.por_agente_sistema['ana › crm2 (crm2:escrever)'] >= 1);
    // o CRM sem cabeçalho combinado não recebe o slug
    await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm/clientes_listar', {}, CAIXA('ana'));
    assert.equal(s.crm.chamadas[s.crm.chamadas.length - 1].agente, null);
    // um endpoint de leitura que devolve as chaves da conta: TODAS as credenciais da ferramenta saem mascaradas
    const conta = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm2/conta', {}, CAIXA('ana'));
    assert.equal(conta.status, 200, conta.texto);
    assert.deepEqual(conta.json.item, { chaves: ['***', '***'], dica: '***' });
    // pedido negado não leva credencial no log (nenhuma foi lida)
    const neg = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-crm2/clientes_listar', {}, CAIXA('bia'));
    assert.equal(neg.status, 404);
    const linhaNeg = s.dados.acessos.ultimas(5).find((l) => l.agente === 'bia' && l.fonte === 'ferramenta-crm2');
    assert.equal(linhaNeg.credencial, undefined);
  } finally { await s.fechar(); }
});
