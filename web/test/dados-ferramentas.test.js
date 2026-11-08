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
const { montaUrl, normalizaResultado, desembrulhaMcp } = require('../lib/dados-fontes/ferramenta');
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
      chamadas.push({ metodo: req.method, url: req.url, auth: req.headers.authorization || null, corpo });
      const j = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers.authorization !== 'Bearer segredo-do-crm-123') return j(401, { erro: 'sem credencial' });
      if (req.method === 'GET' && req.url.startsWith('/api/clientes/')) return j(200, { id: req.url.split('/').pop(), nome: 'Cliente Exemplo', cpf: 'oculto?' });
      if (req.method === 'GET' && req.url.startsWith('/api/clientes')) return j(200, { items: [{ id: '1', nome: 'Um', cpf: '000' }, { id: '2', nome: 'Dois', cpf: '111' }] });
      if (req.method === 'POST' && req.url === '/api/propostas') return j(201, { id: 'p9', recebido: JSON.parse(corpo) });
      if (req.url === '/api/redireciona') { res.writeHead(302, { Location: 'http://127.0.0.1:1/x' }); return res.end(); }
      if (req.url === '/api/texto') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('não é json'); }
      if (req.url === '/api/lento') return setTimeout(() => j(200, {}), 3000);
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
  let u = montaUrl(f, { metodo: 'GET', rota: '/clientes/{id}/notas' }, { id: 'a/b?c', limit: 5 });
  assert.equal(u.url.toString(), 'https://a.test/api/clientes/a%2Fb%3Fc/notas?limit=5'); assert.equal(u.corpo, null);
  u = montaUrl(f, { metodo: 'POST', rota: '/x' }, { a: 1, b: 'y' });
  assert.equal(u.url.toString(), 'https://a.test/api/x'); assert.deepEqual(u.corpo, { a: 1, b: 'y' });
  assert.deepEqual(normalizaResultado([{ a: 1, b: 2 }, { a: 3 }], { campos: ['a'], max_itens: 1 }), { itens: [{ a: 1 }], total: 2, truncado: true });
  assert.deepEqual(normalizaResultado({ data: [{ x: 1 }] }, {}), { itens: [{ x: 1 }], total: 1, truncado: false });
  assert.deepEqual(normalizaResultado({ x: 1, y: 2 }, { campos: ['y'] }), { item: { y: 2 } });
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
        else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ tool: m.params.name, args: m.params.arguments, token: process.env.NOTAS_TOKEN || null, extra: process.env.EXTRA || null, home: process.env.HOME || null }) }] } }) + '\\n');
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
      } },
    vendas: { tipo: 'banco', arquivo: arqDb, operacoes: {
      resumo_mes: { sql: 'SELECT produto, SUM(valor) AS total FROM vendas WHERE mes = :mes GROUP BY produto ORDER BY produto', escopo: 'vendas:ler', params: { mes: { tipo: 'periodo', obrigatorio: true } } },
      apagar_mes: { sql: 'DELETE FROM vendas WHERE mes = :mes', escopo: 'vendas:escrever', acao: true, params: { mes: { tipo: 'periodo', obrigatorio: true } } },
    } },
    notas: { tipo: 'mcp', comando: process.execPath, args: [mcp], credencial: 'notas', credencial_env: 'NOTAS_TOKEN', env: { EXTRA: 'sim' }, timeout_s: 5, operacoes: {
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
  return { dados, pedir, crm, arqDb, arqPapeis, cap, fechar: async () => { srv.close(); await crm.fechar(); fs.rmSync(base, { recursive: true, force: true }); } };
}
const CAIXA = (slug) => ({ usuario: 'agente:' + slug, via: 'caixa', agente: slug });
const DONO = { usuario: 'dono' };

test('API: a credencial sai do cofre para o cabeçalho e nunca para o agente; campos filtrados; redirecionamento, texto e demora são 502/504', async () => {
  const s = await subir();
  try {
    const f = await s.pedir('GET', '/api/v1/dados/fontes', undefined, CAIXA('ana'));
    const crm = f.json.fontes.find((x) => x.nome === 'ferramenta-crm');
    assert.deepEqual(crm.operacoes.sort(), ['cliente_ler', 'clientes_listar', 'lento', 'redireciona', 'texto']);
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
    assert.equal(le.status, 502); assert.match(le.json.erro, /tempo esgotado/);
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
    // bia (papel *, pessoa só crm:ler) não lê vendas
    assert.equal((await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-vendas/resumo_mes', { mes: '2026-10' }, CAIXA('bia'))).status, 403);
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
    assert.deepEqual(r.json.item, { tool: 'search', args: { query: 'reunião' }, token: 'token-notas-xyz', extra: 'sim', home: null });
    assert.ok(!r.texto.includes('NOTAS_TOKEN=') );
    const x = await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-notas/explode', {}, CAIXA('ana'));
    assert.equal(x.status, 502); assert.match(x.json.erro, /tool explodiu/);
    assert.equal((await s.pedir('POST', '/api/v1/dados/fontes/ferramenta-notas/buscar', { query: 'x' }, CAIXA('bia'))).status, 403);
    const cat = await s.pedir('GET', '/api/v1/dados/ferramentas', undefined, DONO);
    assert.equal(cat.json.valido, true); assert.deepEqual(Object.keys(cat.json.ferramentas).sort(), ['crm', 'notas', 'vendas']); assert.deepEqual(cat.json.credenciais, ['crm', 'notas']);
    assert.ok(!cat.texto.includes('segredo-do-crm') && !cat.texto.includes('token-notas'));
    assert.equal((await s.pedir('GET', '/api/v1/dados/ferramentas', undefined, CAIXA('ana'))).status, 403);
  } finally { await s.fechar(); }
});
