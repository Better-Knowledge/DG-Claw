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
    assert.deepEqual(Object.keys(f.operacoes), [], 'a fonte é só ação: o catálogo dos outros escopos não é do agente');
    const a = f.acoes.propor;
    assert.equal(a.acao, 'propor_skill');
    const ctx = { agente: 'ana', pessoa: 'marta', papel: 'analista', politica: c.papeis.estado().politica };
    const ok = a.validar({ nome: 'relatorio-semanal', grupo: 'financeiro', conteudo: SKILL('relatorio-semanal') }, ctx);
    assert.equal(ok.nome, 'relatorio-semanal');
    const lanca = (p, status, rx) => { try { a.validar(p, ctx); } catch (e) { assert.ok(e instanceof ErroFonte); assert.equal(e.status, status, e.message); if (rx) assert.match(e.message, rx); return; } assert.fail('devia recusar ' + JSON.stringify(p)); };
    lanca({ nome: 'X', grupo: 'financeiro', conteudo: SKILL('X') }, 400, /"nome"/);
    lanca({ nome: 'memory', grupo: 'financeiro', conteudo: SKILL('memory') }, 400, /skill da imagem/);
    lanca({ nome: 'aprender', grupo: 'financeiro', conteudo: SKILL('aprender') }, 400, /skill da imagem/);
    lanca({ nome: 'conciliacao', grupo: 'financeiro', conteudo: SKILL('conciliacao') }, 409, /Já existe a skill "conciliacao".*"substituir": true/);
    lanca({ nome: 'a', grupo: 'financeiro', conteudo: SKILL('a') + 'TELEGRAM_TOKEN=1234567890:AAHabcdefghijklmnopqrstuvwxyz0123456\n' }, 400, /segredo/);
    lanca({ nome: 'a', grupo: 'financeiro', conteudo: SKILL('a'), substituir: 'sim' }, 400, /"substituir"/);
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
    // sem substituir, a segunda gravação é recusada; com substituir e validada de novo, passa
    assert.throws(() => a.executar(ok, { agente: 'ana', aprovacao: 'ap2' }), (e) => e instanceof ErroFonte && e.status === 409);
    const ok2 = a.validar({ nome: 'relatorio-semanal', grupo: 'financeiro', conteudo: SKILL('relatorio-semanal') + 'v2\n', substituir: true }, ctx);
    assert.equal(a.executar(ok2, { agente: 'ana', aprovacao: 'ap2' }).substituiu, true);
    // skill publicada pela CLI com outros arquivos: o agente não substitui
    fs.writeFileSync(path.join(c.skillsDir, 'grupos', 'financeiro', 'conciliacao', 'ajuda.py'), 'print(1)');
    lanca({ nome: 'conciliacao', grupo: 'financeiro', conteudo: SKILL('conciliacao'), substituir: true }, 409, /mais arquivos além do SKILL.md/);
    // a pessoa saiu do grupo entre o pedido e a aprovação: a execução recusa
    const semGrupo = JSON.parse(JSON.stringify(PAPEIS)); semGrupo.pessoas.marta.grupos = [];
    fs.writeFileSync(c.arqPapeis, JSON.stringify(semGrupo));
    assert.throws(() => a.executar(ok2, { agente: 'ana', aprovacao: 'ap3' }), (e) => e instanceof ErroFonte && e.status === 403 && /já não faz parte/.test(e.message));
    fs.writeFileSync(c.arqPapeis, JSON.stringify(PAPEIS));
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
    // a fonte skills aparece para quem tem a ação (só ação: não há listar)
    const f = await pedir('GET', '/api/v1/dados/fontes', undefined, CAIXA('ana'));
    const sk = f.json.fontes.find((x) => x.nome === 'skills');
    assert.deepEqual(sk.acoes, { propor: 'propor_skill' });
    assert.equal((await pedir('GET', '/api/v1/dados/fontes', undefined, CAIXA('edu'))).json.fontes.find((x) => x.nome === 'skills'), undefined, 'estagiário não tem a ação');
    const e = await pedir('POST', '/api/v1/dados/fontes/skills/propor', { nome: 'relatorio-semanal', grupo: 'financeiro', conteudo: SKILL('relatorio-semanal') }, CAIXA('ana'));
    assert.equal(e.status, 202, e.texto); assert.match(e.json.pedido.descricao, /skill nova "relatorio-semanal" para o grupo financeiro/);
    assert.ok(!fs.existsSync(path.join(c.skillsDir, 'grupos', 'financeiro', 'relatorio-semanal')));
    assert.equal((await pedir('POST', '/api/v1/dados/fontes/skills/propor', { nome: 'x', grupo: 'projeto-x', conteudo: SKILL('x') }, CAIXA('ana'))).status, 403, 'grupo que não é da pessoa');
    assert.equal((await pedir('POST', '/api/v1/dados/fontes/skills/propor', { nome: 'x', grupo: 'financeiro', conteudo: SKILL('x') }, CAIXA('edu'))).status, 403, 'papel sem a ação');
    const hash = (await pedir('GET', '/api/v1/dados/aprovacoes?estado=pendente')).json.aprovacoes[0].hash;
    const a = await pedir('POST', `/api/v1/dados/aprovacoes/${e.json.pedido.id}/aprovar`, { hash });
    assert.equal(a.status, 200, a.texto); assert.equal(a.json.pedido.estado, 'executada'); assert.match(a.json.pedido.resultado.proximo_passo, /dgclaw skill aplicar/);
    assert.match(e.json.pedido.descricao, /skill nova/);
    // substituir: a frase da aprovação avisa, e sem a flag o pedido nem nasce
    assert.equal((await pedir('POST', '/api/v1/dados/fontes/skills/propor', { nome: 'relatorio-semanal', grupo: 'financeiro', conteudo: SKILL('relatorio-semanal') }, CAIXA('ana'))).status, 409);
    const e2 = await pedir('POST', '/api/v1/dados/fontes/skills/propor', { nome: 'relatorio-semanal', grupo: 'financeiro', conteudo: SKILL('relatorio-semanal') + 'v2\n', substituir: true }, CAIXA('ana'));
    assert.equal(e2.status, 202, e2.texto); assert.match(e2.json.pedido.descricao, /ATENÇÃO: .*SUBSTITUIR a skill "relatorio-semanal"/);
    assert.equal(fs.readFileSync(path.join(c.skillsDir, 'grupos', 'financeiro', 'relatorio-semanal', 'SKILL.md'), 'utf8'), SKILL('relatorio-semanal'));
    assert.ok(!JSON.stringify(dados.acessos.ultimas(50)).includes('passo um'), 'o conteúdo da skill não vai para o log');
    // o dono, pela sessão do painel, propõe e aprova: ele não tem agente na política, e a reconferência do grupo não o barra
    const d1 = await pedir('POST', '/api/v1/dados/fontes/skills/propor', { nome: 'do-dono', grupo: 'projeto-x', conteudo: SKILL('do-dono') });
    assert.equal(d1.status, 202, d1.texto);
    const hd = (await pedir('GET', '/api/v1/dados/aprovacoes?estado=pendente')).json.aprovacoes.find((x) => x.id === d1.json.pedido.id).hash;
    const d2 = await pedir('POST', `/api/v1/dados/aprovacoes/${d1.json.pedido.id}/aprovar`, { hash: hd });
    assert.equal(d2.status, 200, d2.texto); assert.equal(d2.json.pedido.estado, 'executada', JSON.stringify(d2.json.pedido));
    assert.ok(fs.existsSync(path.join(c.skillsDir, 'grupos', 'projeto-x', 'do-dono', 'SKILL.md')));
    // nome de skill global: o pedido nasce igual (sem oráculo de nomes), mas na aprovação a de grupo não é gravada
    fs.mkdirSync(path.join(c.skillsDir, 'globais', 'fechamento'), { recursive: true });
    fs.writeFileSync(path.join(c.skillsDir, 'globais', 'fechamento', 'SKILL.md'), SKILL('fechamento'));
    const g = await pedir('POST', '/api/v1/dados/fontes/skills/propor', { nome: 'fechamento', grupo: 'financeiro', conteudo: SKILL('fechamento') }, CAIXA('ana'));
    assert.equal(g.status, 202, g.texto);
    const hg = (await pedir('GET', '/api/v1/dados/aprovacoes?estado=pendente')).json.aprovacoes.find((x) => x.id === g.json.pedido.id).hash;
    const ga = await pedir('POST', `/api/v1/dados/aprovacoes/${g.json.pedido.id}/aprovar`, { hash: hg });
    assert.equal(ga.json.pedido.estado, 'falhou', ga.texto);
    const visto = await pedir('GET', `/api/v1/dados/pedidos/${g.json.pedido.id}`, undefined, CAIXA('ana'));
    assert.doesNotMatch(JSON.stringify(visto.json), /global/, 'o agente não lê que existe uma global');
    assert.ok(!fs.existsSync(path.join(c.skillsDir, 'grupos', 'financeiro', 'fechamento')));
    assert.match(c.cap.texto(), /já existe uma skill global com esse nome/, 'o motivo de verdade vai para o log do dono');
  } finally { srv.close(); c.fim(); }
});

test('os padrões de segredo são os mesmos para a CLI (grep -Eif) e para o Web (lib/segredos.regex)', () => {
  const { spawnSync } = require('node:child_process');
  const { RX_SEGREDO, carregaSegredos, nomesReservados } = require('../lib/dados-fontes/skills');
  const arquivo = path.join(__dirname, '..', '..', 'lib', 'segredos.regex');
  assert.equal(carregaSegredos(arquivo).source, RX_SEGREDO.source);
  const grep = (s) => spawnSync('grep', ['-Eiq', '-f', arquivo], { input: s + '\n' }).status === 0;
  const positivos = ['GROQ_API_KEY=gsk_WvKabcdefghijklmnopqrstuv', 'Password: Abcdefghijklmnop', 'TELEGRAM_TOKEN=1234567890:AAHabcdefghijklmnopqrstuvwxyz0123456', 'AIzaSyA1234567890abcdefghijklmnopqrstuvwx', 'jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0', 'sk-abcdefghijklmnopqrst', 'API-KEY = "abcdefghijkl.mnop"'];
  const negativos = ['a chave está no cofre, nome OPENAI_API_KEY', 'token: curto', 'senha: a sua', 'use GROQ_API_KEY do cofre'];
  for (const s of positivos) { assert.ok(RX_SEGREDO.test(s), 'web: ' + s); assert.ok(grep(s), 'cli: ' + s); }
  for (const s of negativos) { assert.ok(!RX_SEGREDO.test(s), 'web: ' + s); assert.ok(!grep(s), 'cli: ' + s); }
  // só [[:space:]] é traduzida: outra classe POSIX é recusada, em vez de virar uma classe errada em silêncio
  const base = pastaTemp('segredos');
  try {
    fs.writeFileSync(path.join(base, 'r'), 'x[[:alnum:]]{3}\n');
    assert.throws(() => carregaSegredos(path.join(base, 'r')), /classe POSIX/);
    // comentário e linha vazia no arquivo: os dois lados os ignoram (uma linha vazia no grep casaria tudo)
    const comComentario = path.join(base, 'c');
    fs.writeFileSync(comComentario, '# comentário\n\nsk-[a-z]{16,}\n   \n');
    const rxC = carregaSegredos(comComentario);
    const grepC = (t) => spawnSync('bash', ['-c', 'grep -Eiq -f <(grep -Ev \'^[[:space:]]*(#|$)\' "$1")', '_', comComentario], { input: t + '\n' }).status === 0;
    for (const t of ['sk-abcdefghijklmnopqrst']) { assert.ok(rxC.test(t)); assert.ok(grepC(t)); }
    for (const t of ['nada aqui', '# comentário']) { assert.ok(!rxC.test(t), 'web: ' + t); assert.ok(!grepC(t), 'cli: ' + t); }
    // arquivo só de comentários: os dois lados fecham (erro), em vez de "sem segredo"
    fs.writeFileSync(path.join(base, 'so-comentario'), '# nada\n\n');
    assert.throws(() => carregaSegredos(path.join(base, 'so-comentario')), /vazia/);
    // nomes reservados: lista fixa mesmo sem a pasta skills/, e ok:false para o propor fechar
    const r = nomesReservados(base);
    assert.equal(r.ok, false); assert.ok(r.nomes.has('memory') && r.nomes.has('dgclaw'));
    assert.equal(nomesReservados().ok, true); assert.ok(nomesReservados().nomes.has('aprender'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a lista fixa de skills nativas é a mesma no vida_script do dgclaw, em lib/skills.sh e no Web', () => {
  const raiz = path.join(__dirname, '..', '..');
  const dgclaw = fs.readFileSync(path.join(raiz, 'bin', 'dgclaw'), 'utf8');
  const m = /^for s in ([a-z0-9 -]+); do\n\s+origem="\/opt\/dgclaw\/app\/skills\/\$s"/m.exec(dgclaw);
  assert.ok(m, 'o laço do vida_script que liga as skills da imagem');
  const doVida = m[1].trim().split(/\s+/).sort();
  const sh = /^SKILLS_RESERVADAS_FIXAS=" (.*) "$/m.exec(fs.readFileSync(path.join(raiz, 'lib', 'skills.sh'), 'utf8'));
  assert.ok(sh, 'SKILLS_RESERVADAS_FIXAS em lib/skills.sh');
  const daCli = sh[1].split(/\s+/).filter((x) => x !== 'dgclaw').sort();
  const { nomesReservados } = require('../lib/dados-fontes/skills');
  const doWeb = [...nomesReservados(pastaTemp('vazia')).nomes].filter((x) => x !== 'dgclaw').sort();
  assert.deepEqual(daCli, doVida); assert.deepEqual(doWeb, doVida);
});
