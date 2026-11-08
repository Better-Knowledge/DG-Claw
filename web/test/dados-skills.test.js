'use strict';
// Skills compartilhadas: o bloco "skills" nos papéis, a fonte skills (listar e propor) e a rota com aprovação.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { validaPapeis, criarPapeis } = require('../lib/papeis');
const { criarFontes, ErroFonte } = require('../lib/dados-fontes');
const { criarDados } = require('../lib/dados');
const { pastaTemp, capturaLog } = require('./ajuda');

const PAPEIS = {
  versao: 1,
  grupos: { financeiro: { tipo: 'departamento' }, 'projeto-x': { tipo: 'projeto' } },
  pessoas: {
    marta: { grupos: ['financeiro'], acoes: { propor_skill: 'aprovacao_humana' }, skills: { 'relatorio-semanal': 'negado' } },
    caio: { grupos: ['projeto-x'], acoes: { propor_skill: 'aprovacao_humana' } },
  },
  papeis: {
    analista: { skills: ['*'], acoes: { propor_skill: 'aprovacao_humana' } },
    estagiario: { skills: ['fechamento-mensal'] },
  },
  agentes: { ana: { pessoa: 'marta', papel: 'analista' }, bia: { pessoa: 'caio', papel: 'analista' }, edu: { pessoa: 'marta', papel: 'estagiario' } },
};
const SKILL = (nome) => `---\nname: ${nome}\ndescription: roteiro de teste\n---\n\n# ${nome}\n\n1. passo um\n2. passo dois\n`;

test('papeis.json: papel lista skills (ou *), pessoa só nega', () => {
  const r = validaPapeis(PAPEIS);
  assert.equal(r.ok, true, JSON.stringify(r.erros));
  assert.deepEqual(r.politica.papeis.analista.skills, ['*']);
  assert.deepEqual(r.politica.pessoas.marta.skills, { 'relatorio-semanal': 'negado' });
  assert.match(validaPapeis({ versao: 1, papeis: { r: { skills: ['Maiuscula'] } } }).erros[0], /lista de nomes de skill/);
  assert.match(validaPapeis({ versao: 1, pessoas: { p: { skills: { x: 'leitura' } } } }).erros[0], /só vale "negado"/);
});

function cenario() {
  const base = pastaTemp('skills');
  const skillsDir = path.join(base, 'skills');
  fs.mkdirSync(path.join(skillsDir, 'globais', 'fechamento-mensal'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'globais', 'fechamento-mensal', 'SKILL.md'), SKILL('fechamento-mensal'));
  fs.mkdirSync(path.join(skillsDir, 'grupos', 'financeiro', 'conciliacao'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'grupos', 'financeiro', 'conciliacao', 'SKILL.md'), SKILL('conciliacao'));
  fs.mkdirSync(path.join(skillsDir, 'globais', 'Invalida'), { recursive: true });
  const arqPapeis = path.join(base, 'papeis.json'); fs.writeFileSync(arqPapeis, JSON.stringify(PAPEIS));
  const cap = capturaLog();
  const papeis = criarPapeis({ caminho: arqPapeis, log: cap.log });
  return { base, skillsDir, arqPapeis, cap, papeis, fim: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('fonte skills: lista o catálogo compartilhado; propor valida frontmatter, grupo da pessoa e segredo', () => {
  const c = cenario();
  try {
    const fontes = criarFontes({ dir: path.join(c.base, 'fontes'), log: c.cap.log, skillsDir: c.skillsDir, papeis: c.papeis });
    const f = fontes.obter('skills');
    const l = f.operacoes.listar({});
    assert.deepEqual(l.itens.map((i) => [i.nome, i.escopo]), [['fechamento-mensal', 'global'], ['conciliacao', 'grupo:financeiro']]);
    const a = f.acoes.propor;
    assert.equal(a.acao, 'propor_skill');
    const ctx = { agente: 'ana', pessoa: 'marta', papel: 'analista', politica: c.papeis.estado().politica };
    const ok = a.validar({ nome: 'relatorio-semanal', grupo: 'financeiro', conteudo: SKILL('relatorio-semanal') }, ctx);
    assert.equal(ok.nome, 'relatorio-semanal');
    const lanca = (p, status, rx) => { try { a.validar(p, ctx); } catch (e) { assert.ok(e instanceof ErroFonte); assert.equal(e.status, status, e.message); if (rx) assert.match(e.message, rx); return; } assert.fail('devia recusar ' + JSON.stringify(p)); };
    lanca({ nome: 'X', grupo: 'financeiro', conteudo: SKILL('X') }, 400, /"nome"/);
    lanca({ nome: 'a', grupo: 'projeto-x', conteudo: SKILL('a') }, 403, /não faz parte do grupo "projeto-x"/);
    lanca({ nome: 'a', grupo: 'financeiro', conteudo: '# sem frontmatter' }, 400, /frontmatter/);
    lanca({ nome: 'a', grupo: 'financeiro', conteudo: SKILL('b') }, 400, /name: b/);
    lanca({ nome: 'a', grupo: 'financeiro', conteudo: '---\nname: a\n---\ncorpo' }, 400, /description/);
    lanca({ nome: 'a', grupo: 'financeiro', conteudo: SKILL('a') + '\nchave: api_key = sk-abcdefghijklmnopqrstuvwxyz\n' }, 400, /segredo/);
    lanca({ nome: 'a', grupo: 'financeiro', conteudo: SKILL('a') + 'x​' }, 400, /invisíveis/);
    lanca({ nome: 'a', grupo: 'financeiro', conteudo: SKILL('a'), extra: 1 }, 400, /"extra" não existe/);
    // executar grava 755/644 dentro do catálogo e recusa atalho no caminho
    const r = a.executar(ok, { agente: 'ana', aprovacao: 'ap1' });
    assert.equal(r.gravada, true); assert.equal(r.substituiu, false);
    const arq = path.join(c.skillsDir, 'grupos', 'financeiro', 'relatorio-semanal', 'SKILL.md');
    assert.equal(fs.readFileSync(arq, 'utf8'), SKILL('relatorio-semanal'));
    assert.equal(fs.statSync(arq).mode & 0o777, 0o644); assert.equal(fs.statSync(path.dirname(arq)).mode & 0o777, 0o755);
    assert.equal(a.executar(ok, { agente: 'ana', aprovacao: 'ap2' }).substituiu, true);
    fs.mkdirSync(path.join(c.skillsDir, 'grupos', 'atalhado')); fs.symlinkSync(c.base, path.join(c.skillsDir, 'grupos', 'atalhado', 'fuga'));
    assert.throws(() => a.executar({ nome: 'fuga', grupo: 'atalhado', conteudo: SKILL('fuga') }, { agente: 'ana' }), (e) => e instanceof ErroFonte && e.status === 403);
    assert.ok(!fs.existsSync(path.join(c.base, 'SKILL.md')));
  } finally { c.fim(); }
});

test('rota: propor skill vira aprovação; o dono aprova e o arquivo nasce no grupo; grupo alheio e papel sem a ação são negados', async () => {
  const c = cenario();
  const dir = path.join(c.base, 'dados');
  const dados = criarDados({ dir, papeis: c.papeis, skillsDir: c.skillsDir, push: null, log: c.cap.log, agora: () => Date.UTC(2026, 10, 8, 12, 0, 0) });
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
      const p = []; res.on('data', (x) => p.push(x));
      res.on('end', () => { const texto = Buffer.concat(p).toString('utf8'); let json = null; try { json = JSON.parse(texto); } catch (_) { /* texto */ } resolve({ status: res.statusCode, texto, json }); });
    });
    rq.on('error', reject); if (txt) rq.write(txt); rq.end();
  });
  const CAIXA = (slug) => ({ usuario: 'agente:' + slug, via: 'caixa', agente: slug });
  try {
    // a fonte skills aparece para quem tem a ação (e ninguém lê "listar" sem leitura declarada: só a ação)
    const f = await pedir('GET', '/api/v1/dados/fontes', undefined, CAIXA('ana'));
    const sk = f.json.fontes.find((x) => x.nome === 'skills');
    assert.deepEqual(sk.acoes, { propor: 'propor_skill' });
    assert.equal((await pedir('GET', '/api/v1/dados/fontes', undefined, CAIXA('edu'))).json.fontes.find((x) => x.nome === 'skills'), undefined, 'estagiário não tem a ação');
    const e = await pedir('POST', '/api/v1/dados/fontes/skills/propor', { nome: 'relatorio-semanal', grupo: 'financeiro', conteudo: SKILL('relatorio-semanal') }, CAIXA('ana'));
    assert.equal(e.status, 202, e.texto); assert.match(e.json.pedido.descricao, /skill "relatorio-semanal" para o grupo financeiro/);
    assert.ok(!fs.existsSync(path.join(c.skillsDir, 'grupos', 'financeiro', 'relatorio-semanal')));
    assert.equal((await pedir('POST', '/api/v1/dados/fontes/skills/propor', { nome: 'x', grupo: 'projeto-x', conteudo: SKILL('x') }, CAIXA('ana'))).status, 403, 'grupo que não é da pessoa');
    assert.equal((await pedir('POST', '/api/v1/dados/fontes/skills/propor', { nome: 'x', grupo: 'financeiro', conteudo: SKILL('x') }, CAIXA('edu'))).status, 403, 'papel sem a ação');
    const hash = (await pedir('GET', '/api/v1/dados/aprovacoes?estado=pendente')).json.aprovacoes[0].hash;
    const a = await pedir('POST', `/api/v1/dados/aprovacoes/${e.json.pedido.id}/aprovar`, { hash });
    assert.equal(a.status, 200, a.texto); assert.equal(a.json.pedido.estado, 'executada'); assert.match(a.json.pedido.resultado.proximo_passo, /dgclaw skill aplicar/);
    assert.equal(fs.readFileSync(path.join(c.skillsDir, 'grupos', 'financeiro', 'relatorio-semanal', 'SKILL.md'), 'utf8'), SKILL('relatorio-semanal'));
    assert.ok(!JSON.stringify(dados.acessos.ultimas(50)).includes('passo um'), 'o conteúdo da skill não vai para o log');
  } finally { srv.close(); c.fim(); }
});
