'use strict';
// Painel de acessos: a visão (efetivo por agente) e a edição do papeis.json pelo Web, sem perder o que o
// validador não conhece e sem gravar um arquivo inválido. Contrato em web/docs/ACESSOS.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirWeb, cliente, pastaTemp } = require('./ajuda');

const AG = [
  { slug: 'admin', nome: 'Admin', tipo: 'admin', runner: 'http://127.0.0.1:1', agente_id: 'a0' },
  { slug: 'ana', nome: 'Ana', tipo: 'agente', runner: 'http://127.0.0.1:1', agente_id: 'a1', instancia: 'i-ana' },
  { slug: 'bia', nome: 'Bia', tipo: 'agente', runner: 'http://127.0.0.1:1', agente_id: 'a2', instancia: 'i-bia' },
];
const PAPEIS = {
  versao: 1,
  comentario: 'um comentário do dono que o painel não pode perder',
  grupos: { financeiro: { tipo: 'departamento' } },
  pessoas: { marta: { nome: 'Marta', grupos: ['financeiro'], fontes: { agenda: 'leitura', clientes: { nivel: 'leitura', campos: ['nome', 'telefone'] } }, acoes: { enviar_email: 'aprovacao_humana' }, bases: { '*': 'leitura' }, comentario: 'da marta' } },
  papeis: { recepcao: { fontes: { agenda: 'leitura', clientes: 'leitura' }, acoes: { enviar_email: 'aprovacao_humana' }, bases: { '*': 'leitura' }, comentario: 'do papel' } },
  agentes: { ana: { pessoa: 'marta', papel: 'recepcao' } },
};

async function cenario() {
  const dir = pastaTemp('ac');
  const arq = path.join(dir, 'papeis.json');
  fs.writeFileSync(arq, JSON.stringify(PAPEIS, null, 2) + '\n', { mode: 0o600 });
  const basesJson = path.join(dir, 'bases.json');
  fs.writeFileSync(basesJson, JSON.stringify({ versao: 1, bases: { 'manual-rh': { escopo: 'empresa' }, 'fechamento-fin': { escopo: 'grupo', grupo: 'financeiro' }, 'notas-caio': { escopo: 'privada', pessoa: 'caio' } } }));
  const skills = path.join(dir, 'skills');
  fs.mkdirSync(path.join(skills, 'globais', 'fechamento-mensal'), { recursive: true }); fs.writeFileSync(path.join(skills, 'globais', 'fechamento-mensal', 'SKILL.md'), '---\nname: fechamento-mensal\n---\n');
  fs.mkdirSync(path.join(skills, 'grupos', 'financeiro', 'conciliacao'), { recursive: true }); fs.writeFileSync(path.join(skills, 'grupos', 'financeiro', 'conciliacao', 'SKILL.md'), '---\nname: conciliacao\n---\n');
  const t = await subirWeb({ agentes: AG, env: { DGCLAW_PAPEIS: arq, DGCLAW_BASES: basesJson, DGCLAW_BASES_DIR: path.join(dir, 'b'), DGCLAW_SKILLS_DIR: skills } });
  fs.writeFileSync(path.join(t.publico, 'acessos.html'), '<html>acessos</html>');
  await t.login();
  return { t, arq, dir };
}
const ler = (arq) => JSON.parse(fs.readFileSync(arq, 'utf8'));

test('a visão: agente com pessoa e papel mostra o efetivo (fontes com campos, bases por escopo, skills de grupo, ações); agente fora do arquivo mostra nada', async () => {
  const c = await cenario();
  try {
    const r = await c.t.c.get('/api/v1/acessos');
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.politica_ok, true);
    assert.deepEqual(r.json.agentes.map((a) => a.slug), ['ana', 'bia'], 'o Admin não entra');
    const ana = r.json.agentes[0];
    assert.equal(ana.pessoa, 'marta'); assert.equal(ana.papel, 'recepcao');
    assert.deepEqual(ana.efetivo.fontes.map((f) => f.nome).sort(), ['agenda', 'clientes']);
    assert.deepEqual(ana.efetivo.fontes.find((f) => f.nome === 'clientes').campos, ['nome', 'telefone']);
    assert.deepEqual(ana.efetivo.bases.map((b) => b.nome).sort(), ['fechamento-fin', 'manual-rh'], 'a privada de outra pessoa fica fora');
    assert.deepEqual(ana.efetivo.skills, [], 'o papel não lista skills: nenhuma compartilhada');
    assert.ok(ana.efetivo.acoes.some((a) => a.startsWith('enviar_email')));
    assert.deepEqual(ana.colaboradores, [], 'ninguém convidado ainda');
    const bia = r.json.agentes[1];
    assert.equal(bia.pessoa, null); assert.deepEqual(bia.efetivo.fontes, []);
    assert.ok(r.json.catalogos.fontes.some((f) => f.nome === 'clientes' && f.campos.includes('cpf')));
    assert.deepEqual(r.json.catalogos.skills.map((s) => s.nome + '@' + s.escopo).sort(), ['conciliacao@grupo:financeiro', 'fechamento-mensal@global']);
    assert.equal(r.json.bruto.pessoas.marta.comentario, 'da marta');
  } finally { await c.t.fechar(); }
});

test('editar papel, pessoa, agente e grupo: o arquivo mantém o que o validador não conhece; inválido não grava; em uso não remove', async () => {
  const c = await cenario();
  try {
    // papel: troca os blocos dados e deixa o comentário
    let r = await c.t.c.post('/api/v1/acessos/papel/recepcao', { json: { skills: ['*'], ferramentas: ['crm:ler'], bases: { '*': 'leitura', 'fechamento-fin': 'negado' } } });
    assert.equal(r.status, 200, r.texto);
    let j = ler(c.arq);
    assert.equal(j.comentario, PAPEIS.comentario); assert.equal(j.papeis.recepcao.comentario, 'do papel');
    assert.deepEqual(j.papeis.recepcao.skills, ['*']); assert.deepEqual(j.papeis.recepcao.fontes, PAPEIS.papeis.recepcao.fontes, 'bloco não enviado fica');
    assert.equal(fs.statSync(c.arq).mode & 0o777, 0o600);
    const v = (await c.t.c.get('/api/v1/acessos')).json.agentes[0].efetivo;
    assert.deepEqual([...v.skills].sort(), ['conciliacao', 'fechamento-mensal'], 'com "*" no papel e a marta no financeiro, as duas entram');
    assert.deepEqual(v.bases.map((b) => b.nome), ['manual-rh'], 'a negada por nome saiu');
    // inválido: nível desconhecido; nada muda
    const antes = fs.readFileSync(c.arq, 'utf8');
    r = await c.t.c.post('/api/v1/acessos/papel/recepcao', { json: { fontes: { agenda: 'escrita' } } });
    assert.equal(r.status, 400); assert.match(r.json.erro, /inválido/); assert.ok(Array.isArray(r.json.erros));
    assert.equal(fs.readFileSync(c.arq, 'utf8'), antes);
    r = await c.t.c.post('/api/v1/acessos/papel/Maiusculo', { json: {} });
    assert.equal(r.status, 400);
    // pessoa nova + grupo novo + agente ligado
    assert.equal((await c.t.c.post('/api/v1/acessos/grupo/projeto-x', { json: { tipo: 'projeto', nome: 'Projeto X' } })).status, 200);
    r = await c.t.c.post('/api/v1/acessos/pessoa/caio', { json: { nome: 'Caio', grupos: ['projeto-x'], fontes: { agenda: 'leitura' }, estado: 'ativa' } });
    assert.equal(r.status, 200, r.texto);
    r = await c.t.c.post('/api/v1/acessos/agente/bia', { json: { pessoa: 'caio', papel: 'recepcao' } });
    assert.equal(r.status, 200, r.texto); assert.deepEqual(r.json.agente, { pessoa: 'caio', papel: 'recepcao' });
    j = ler(c.arq); assert.deepEqual(j.agentes.bia, { pessoa: 'caio', papel: 'recepcao' }); assert.equal(j.grupos['projeto-x'].nome, 'Projeto X');
    const bia = (await c.t.c.get('/api/v1/acessos')).json.agentes.find((a) => a.slug === 'bia');
    assert.deepEqual(bia.efetivo.fontes.map((f) => f.nome), ['agenda']);
    // pessoa que aponta para grupo inexistente: inválido
    assert.equal((await c.t.c.post('/api/v1/acessos/pessoa/caio', { json: { grupos: ['nao-existe'] } })).status, 400);
    // remover em uso: 409; tirar o agente e remover: 200
    assert.equal((await c.t.c.pedir('DELETE', '/api/v1/acessos/pessoa/caio')).status, 409);
    assert.equal((await c.t.c.pedir('DELETE', '/api/v1/acessos/grupo/projeto-x')).status, 409);
    assert.equal((await c.t.c.post('/api/v1/acessos/agente/bia', { json: { remover: true } })).status, 200);
    assert.equal((await c.t.c.pedir('DELETE', '/api/v1/acessos/pessoa/caio')).status, 200);
    assert.equal((await c.t.c.pedir('DELETE', '/api/v1/acessos/grupo/projeto-x')).status, 200);
    assert.equal((await c.t.c.post('/api/v1/acessos/agente/admin', { json: { pessoa: 'marta', papel: 'recepcao' } })).status, 400);
    assert.equal((await c.t.c.post('/api/v1/acessos/agente/zed', { json: { pessoa: 'marta', papel: 'recepcao' } })).status, 404);
    j = ler(c.arq); assert.equal(j.comentario, PAPEIS.comentario); assert.equal(j.pessoas.caio, undefined);
  } finally { await c.t.fechar(); }
});

test('só o dono: o colaborador leva 403 na API e é mandado ao agente dele na tela; a visão lista os colaboradores do agente', async () => {
  const c = await cenario();
  try {
    const cr = await c.t.c.post('/api/v1/colaboradores', { json: { agentes: ['ana'], email: 'edu@x.com', nome: 'Edu' } });
    assert.equal(cr.status, 201, cr.texto);
    const e = cliente(c.t.porta);
    assert.equal((await e.post('/login', { json: { usuario: 'edu@x.com', senha: cr.json.convite.senha_temporaria } })).status, 200);
    assert.equal((await e.post('/api/v1/eu/senha', { json: { nova: 'senha-do-edu-123456', confirmacao: 'senha-do-edu-123456' } })).status, 200);
    assert.equal((await e.get('/api/v1/acessos')).status, 403);
    assert.equal((await e.post('/api/v1/acessos/papel/recepcao', { json: { skills: ['*'] } })).status, 403);
    const pg = await e.get('/acessos', { headers: { Accept: 'text/html' } });
    assert.equal(pg.status, 302); assert.equal(pg.headers.location, '/a/ana');
    assert.equal((await c.t.c.get('/acessos', { headers: { Accept: 'text/html' } })).status, 200);
    assert.equal(ler(c.arq).papeis.recepcao.skills, undefined);
    const v = (await c.t.c.get('/api/v1/acessos')).json;
    assert.deepEqual(v.agentes.find((a) => a.slug === 'ana').colaboradores, [{ email: 'edu@x.com', nome: 'Edu' }]);
    assert.deepEqual(v.agentes.find((a) => a.slug === 'bia').colaboradores, []);
  } finally { await c.t.fechar(); }
});
