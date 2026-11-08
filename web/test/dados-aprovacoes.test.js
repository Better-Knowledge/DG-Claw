'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarAprovacoes, canonico, hashDaAcao, ErroAprovacao } = require('../lib/dados-aprovacoes');
const { pastaTemp, capturaLog } = require('./ajuda');

function cenario(opcoes) {
  const dir = pastaTemp('aprov');
  const cap = capturaLog();
  const relogio = { t: Date.UTC(2026, 10, 8, 12, 0, 0) };
  const a = criarAprovacoes(Object.assign({ dir, log: cap.log, agora: () => relogio.t }, opcoes || {}));
  return { dir, cap, relogio, a, fim: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const PEDIDO = { agente: 'ana', pessoa: 'marta', papel: 'recepcao', fonte: 'email', operacao: 'enviar', acao: 'enviar_email', params: { para: 'x@exemplo.test', assunto: 'Oi', texto: 'olá' }, descricao: 'A Ana quer enviar um e-mail', pedido_por: 'agente:ana' };
const lanca = (fn, status, rx) => {
  try { fn(); } catch (e) { assert.ok(e instanceof ErroAprovacao, e && e.stack); assert.equal(e.status, status, e.message); if (rx) assert.match(e.message, rx); return; }
  assert.fail('devia ter lançado');
};

test('canônico ordena as chaves em todo nível; o hash muda com um byte', () => {
  assert.equal(canonico({ b: 1, a: { d: [1, { z: 0, y: null }], c: 'x' } }), '{"a":{"c":"x","d":[1,{"y":null,"z":0}]},"b":1}');
  const h1 = hashDaAcao(PEDIDO);
  assert.equal(h1, hashDaAcao(Object.assign({}, PEDIDO, { params: { texto: 'olá', assunto: 'Oi', para: 'x@exemplo.test' } })), 'ordem das chaves não muda o hash');
  assert.notEqual(h1, hashDaAcao(Object.assign({}, PEDIDO, { params: Object.assign({}, PEDIDO.params, { texto: 'olá.' }) })));
  assert.notEqual(h1, hashDaAcao(Object.assign({}, PEDIDO, { agente: 'bia' })));
});

test('pedir cria pendente com prazo; o mesmo pedido repetido devolve o mesmo id; aprovar executa uma vez só', () => {
  const c = cenario();
  try {
    const p = c.a.pedir(PEDIDO);
    assert.match(p.id, /^[0-9a-f]{24}$/);
    assert.equal(p.estado, 'pendente'); assert.equal(p.expira_em, '2026-11-08T12:15:00.000Z');
    assert.equal(p.hash, hashDaAcao(PEDIDO));
    assert.deepEqual(p.params, PEDIDO.params);
    assert.equal(c.a.pedir(PEDIDO).id, p.id, 'repetido enquanto pendente não duplica');
    assert.notEqual(c.a.pedir(Object.assign({}, PEDIDO, { agente: 'bia' })).id, p.id);
    assert.equal(c.a.pendentes().length, 2);
    assert.equal(fs.statSync(path.join(c.dir, 'aprovacoes.json')).mode & 0o777, 0o600);

    const interno = c.a.aprovar(p.id, { hash: p.hash, por: 'dono' });
    assert.equal(interno.estado, 'aprovada'); assert.equal(interno.usada_em, '2026-11-08T12:00:00.000Z');
    lanca(() => c.a.aprovar(p.id, { hash: p.hash, por: 'dono' }), 409, /já está aprovada; cada pedido vale uma vez/);
    const fim = c.a.concluir(p.id, { ok: true, resultado: { simulado: true } });
    assert.equal(fim.estado, 'executada'); assert.deepEqual(fim.resultado, { simulado: true });
    lanca(() => c.a.aprovar(p.id, { hash: p.hash, por: 'dono' }), 409);
    lanca(() => c.a.recusar(p.id, { por: 'dono' }), 409);
    // obter sem params não expõe os parâmetros
    assert.equal(c.a.obter(p.id).params, undefined);
    assert.deepEqual(c.a.obter(p.id, true).params, PEDIDO.params);
  } finally { c.fim(); }
});

test('hash alterado em um byte, hash de outro pedido, prazo vencido e id inválido são recusados', () => {
  const c = cenario();
  try {
    const p = c.a.pedir(PEDIDO);
    const outro = c.a.pedir(Object.assign({}, PEDIDO, { params: Object.assign({}, PEDIDO.params, { texto: 'olá!' }) }));
    const mexido = p.hash.slice(0, -1) + (p.hash.endsWith('0') ? '1' : '0');
    lanca(() => c.a.aprovar(p.id, { hash: mexido, por: 'dono' }), 409, /não é exatamente o que foi pedido/);
    lanca(() => c.a.aprovar(p.id, { hash: outro.hash, por: 'dono' }), 409);
    lanca(() => c.a.aprovar(p.id, { hash: 42, por: 'dono' }), 409);
    assert.equal(c.a.obter(p.id).estado, 'pendente', 'uma recusa de hash não muda o pedido');
    lanca(() => c.a.aprovar('zzz', { hash: p.hash, por: 'dono' }), 400);
    lanca(() => c.a.aprovar('0'.repeat(24), { hash: p.hash, por: 'dono' }), 404);
    // arquivo adulterado: params trocados no disco com o hash antigo => hash recalculado não bate
    const arq = path.join(c.dir, 'aprovacoes.json');
    const d = JSON.parse(fs.readFileSync(arq, 'utf8'));
    d.itens.find((x) => x.id === p.id).params.para = 'atacante@exemplo.test';
    fs.writeFileSync(arq, JSON.stringify(d));
    lanca(() => c.a.aprovar(p.id, { hash: p.hash, por: 'dono' }), 409, /não bate/);
    // prazo vencido
    c.relogio.t += 15 * 60 * 1000 + 1;
    lanca(() => c.a.aprovar(outro.id, { hash: outro.hash, por: 'dono' }), 409, /já está expirada/);
    assert.equal(c.a.pendentes().length, 0);
  } finally { c.fim(); }
});

test('conferir() na aprovação revoga quando a política mudou; revogar() limpa pendentes por teste', () => {
  const c = cenario();
  try {
    const p = c.a.pedir(PEDIDO);
    lanca(() => c.a.aprovar(p.id, { hash: p.hash, por: 'dono', conferir: () => 'a pessoa marta saiu do arquivo' }), 403, /Não aprovei: a pessoa marta saiu/);
    assert.equal(c.a.obter(p.id).estado, 'revogada');
    const q = c.a.pedir(Object.assign({}, PEDIDO, { agente: 'bia' }));
    const r = c.a.pedir(Object.assign({}, PEDIDO, { agente: 'caio' }));
    assert.equal(c.a.revogar((x) => x.agente === 'bia', 'bia saiu', 'sistema'), 1);
    assert.equal(c.a.obter(q.id).estado, 'revogada'); assert.equal(c.a.obter(q.id).motivo, 'bia saiu');
    assert.equal(c.a.obter(r.id).estado, 'pendente');
    const rec = c.a.recusar(r.id, { por: 'dono', motivo: 'não agora' });
    assert.equal(rec.estado, 'recusada'); assert.equal(rec.motivo, 'não agora');
    assert.deepEqual(c.a.listar({ estado: 'revogada' }).map((x) => x.id).sort(), [p.id, q.id].sort());
    assert.equal(c.a.listar({ agente: 'caio' }).length, 1);
  } finally { c.fim(); }
});

test('arquivo quebrado não é substituído em silêncio e params grandes demais são recusados', () => {
  const c = cenario();
  try {
    c.a.pedir(PEDIDO);
    const arq = path.join(c.dir, 'aprovacoes.json');
    fs.writeFileSync(arq, '{ quebrado');
    assert.deepEqual(c.a.pendentes(), []);
    assert.ok(fs.existsSync(arq + '.quebrado'));
    assert.match(c.cap.texto(), /\[erro\] Aprovações de dados: .*ilegível/);
    lanca(() => c.a.pedir(Object.assign({}, PEDIDO, { params: { texto: 'x'.repeat(70000) } })), 413, /teto é 65536/);
  } finally { c.fim(); }
});

test('prazo configurável e a lista guarda só os 500 últimos decididos', () => {
  const c = cenario({ prazoMs: 1000 });
  try {
    const p = c.a.pedir(PEDIDO);
    assert.equal(p.expira_em, '2026-11-08T12:00:01.000Z');
    for (let i = 0; i < 505; i++) {
      const x = c.a.pedir(Object.assign({}, PEDIDO, { params: { para: 'x@exemplo.test', assunto: 'n' + i, texto: 't' } }));
      c.a.recusar(x.id, { por: 'dono' });
    }
    assert.equal(c.a.listar({ estado: 'recusada', limit: 500 }).length, 500);
    assert.equal(c.a.listar({ estado: 'recusada' }).length, 100, 'sem limit, 100');
    assert.equal(c.a.listar({ estado: 'recusada' })[0].params, undefined, 'decidido sai sem params');
    assert.equal(c.a.obter(p.id).estado, 'pendente', 'pendente nunca é descartado');
  } finally { c.fim(); }
});

test('teto de pendentes por agente e global; `novo` diz se o pedido acabou de nascer', () => {
  const c = cenario();
  try {
    assert.equal(c.a.pedir(PEDIDO).novo, true);
    assert.equal(c.a.pedir(PEDIDO).novo, false);
    for (let i = 1; i < 10; i++) c.a.pedir(Object.assign({}, PEDIDO, { params: { para: 'x@exemplo.test', assunto: 'n' + i, texto: 't' } }));
    lanca(() => c.a.pedir(Object.assign({}, PEDIDO, { params: { para: 'x@exemplo.test', assunto: 'n11', texto: 't' } })), 429, /já tem 10 pedidos esperando/);
    assert.equal(c.a.pedir(PEDIDO).novo, false, 'repetir um pendente ainda funciona com a fila cheia');
    // global: 20 agentes com 10 cada = 200
    for (let a = 0; a < 19; a++) for (let i = 0; i < 10; i++) c.a.pedir(Object.assign({}, PEDIDO, { agente: 'ag' + a, params: { para: 'x@exemplo.test', assunto: 'g' + i, texto: 't' } }));
    assert.equal(c.a.pendentes().length, 200);
    lanca(() => c.a.pedir(Object.assign({}, PEDIDO, { agente: 'novo', params: { para: 'x@exemplo.test', assunto: 'z', texto: 't' } })), 429, /200 pedidos esperando aprovação no painel/);
  } finally { c.fim(); }
});

test('gravação que falha não deixa a memória diferente do disco', () => {
  const c = cenario();
  try {
    const p = c.a.pedir(PEDIDO);
    // simula disco cheio na troca do temporário pelo arquivo final
    const original = fs.renameSync;
    fs.renameSync = () => { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); };
    try {
      lanca(() => c.a.aprovar(p.id, { hash: p.hash, por: 'dono' }), 503, /Não consegui gravar/);
      lanca(() => c.a.pedir(Object.assign({}, PEDIDO, { params: { para: 'x@exemplo.test', assunto: 'outro', texto: 't' } })), 503);
    } finally { fs.renameSync = original; }
    assert.deepEqual(fs.readdirSync(c.dir).filter((n) => n.endsWith('.tmp')), [], 'temporário apagado');
    // o pedido continua pendente (nem "aprovada" presa, nem o segundo pedido fantasma) e a aprovação funciona agora
    assert.equal(c.a.obter(p.id).estado, 'pendente');
    assert.equal(c.a.pendentes().length, 1);
    assert.equal(c.a.aprovar(p.id, { hash: p.hash, por: 'dono' }).estado, 'aprovada');
  } finally { c.fim(); }
});
