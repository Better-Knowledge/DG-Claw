'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarDadosLog } = require('../lib/dados-log');
const { pastaTemp, capturaLog } = require('./ajuda');

test('uma linha JSON por pedido, sem parâmetros nem conteúdo; arquivo por dia com 600; retenção apaga os velhos', () => {
  const base = pastaTemp('dlog');
  const dir = path.join(base, 'log');
  const cap = capturaLog();
  const relogio = { t: Date.UTC(2026, 10, 8, 12, 0, 0) };
  const l = criarDadosLog({ dir, log: cap.log, agora: () => relogio.t, retencaoDias: 3 });
  try {
    assert.equal(l.registrar({ agente: 'ana', pessoa: 'marta', papel: 'recepcao', fonte: 'clientes', operacao: 'listar', decisao: 'permitido', motivo: 'm'.repeat(400), status: 200, itens: 2, bytes: 300, params: { termo: 'SEGREDO' }, conteudo: 'DADO' }), true);
    const arq = path.join(dir, 'acessos-2026-11-08.jsonl');
    assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    const linha = JSON.parse(fs.readFileSync(arq, 'utf8').trim());
    assert.equal(linha.quando, '2026-11-08T12:00:00.000Z');
    assert.equal(linha.agente, 'ana'); assert.equal(linha.decisao, 'permitido'); assert.equal(linha.itens, 2);
    assert.equal(linha.motivo.length, 300, 'motivo cortado');
    assert.equal(linha.params, undefined); assert.equal(linha.conteudo, undefined);
    assert.ok(!fs.readFileSync(arq, 'utf8').includes('SEGREDO'));

    // outro dia: arquivo novo, e os mais velhos que a retenção somem
    fs.writeFileSync(path.join(dir, 'acessos-2026-11-01.jsonl'), '{"quando":"2026-11-01T00:00:00.000Z","agente":"velho"}\n');
    fs.writeFileSync(path.join(dir, 'acessos-2026-11-06.jsonl'), '{"quando":"2026-11-06T00:00:00.000Z","agente":"recente"}\n');
    fs.writeFileSync(path.join(dir, 'outro.txt'), 'não é meu');
    relogio.t += 86400000;
    l.registrar({ agente: 'bia', fonte: 'agenda', operacao: 'ler', decisao: 'negado', motivo: 'x', status: 403 });
    assert.ok(fs.existsSync(path.join(dir, 'acessos-2026-11-09.jsonl')));
    assert.ok(!fs.existsSync(path.join(dir, 'acessos-2026-11-01.jsonl')), 'mais velho que 3 dias foi apagado');
    assert.ok(fs.existsSync(path.join(dir, 'acessos-2026-11-06.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'outro.txt')), 'só arquivos do log são apagados');
    assert.match(cap.texto(), /apaguei acessos-2026-11-01.jsonl/);

    const u = l.ultimas(10);
    assert.deepEqual(u.map((x) => x.agente), ['bia', 'ana', 'recente']);
    assert.equal(l.ultimas(1).length, 1);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('falha ao gravar não derruba o pedido: vira linha de erro no log do Web', () => {
  const base = pastaTemp('dlog2');
  const cap = capturaLog();
  const arquivoNoLugarDaPasta = path.join(base, 'log');
  fs.writeFileSync(arquivoNoLugarDaPasta, 'não sou pasta');
  const l = criarDadosLog({ dir: arquivoNoLugarDaPasta, log: cap.log, agora: () => Date.now() });
  try {
    assert.equal(l.registrar({ agente: 'ana', fonte: 'x', operacao: 'y', decisao: 'negado', motivo: 'z', status: 403 }), false);
    assert.match(cap.texto(), /\[erro\] Log de dados: não consegui gravar a linha de ana/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('filtrar, resumo e csv: por agente, pessoa, fonte, decisão e período; csv escapa e nunca traz conteúdo', () => {
  const base = pastaTemp('dlog3');
  const dir = path.join(base, 'log');
  const cap = capturaLog();
  const relogio = { t: Date.UTC(2026, 10, 8, 12, 0, 0) };
  const l = criarDadosLog({ dir, log: cap.log, agora: () => relogio.t, retencaoDias: 90 });
  try {
    l.registrar({ agente: 'ana', pessoa: 'marta', papel: 'r', fonte: 'clientes', operacao: 'listar', decisao: 'permitido', motivo: 'ok', status: 200, itens: 2, bytes: 100 });
    l.registrar({ agente: 'bia', pessoa: 'caio', papel: 'a', fonte: 'folha', operacao: 'listar', decisao: 'negado', motivo: 'a pessoa "caio", com vírgula, nega', status: 403 });
    relogio.t -= 2 * 86400000;
    l.registrar({ agente: 'ana', pessoa: 'marta', papel: 'r', fonte: 'base-manual-rh', escopo: 'empresa', operacao: 'buscar', decisao: 'permitido', motivo: 'ok', status: 200, itens: 1, bytes: 50 });
    relogio.t += 2 * 86400000;
    assert.equal(l.filtrar({}).length, 3);
    assert.deepEqual(l.filtrar({ agente: 'ana' }).map((x) => x.fonte), ['clientes', 'base-manual-rh']);
    assert.deepEqual(l.filtrar({ decisao: 'negado' }).map((x) => x.agente), ['bia']);
    assert.deepEqual(l.filtrar({ pessoa: 'marta', fonte: 'base-manual-rh' }).length, 1);
    assert.deepEqual(l.filtrar({ desde: '2026-11-08' }).length, 2);
    assert.deepEqual(l.filtrar({ ate: '2026-11-06' }).map((x) => x.fonte), ['base-manual-rh']);
    assert.equal(l.filtrar({ limit: 1 }).length, 1);
    const r = l.resumo('2026-11-01');
    assert.equal(r.linhas, 3); assert.deepEqual(r.por_decisao, { permitido: 2, negado: 1 }); assert.deepEqual(r.por_agente, { ana: 2, bia: 1 }); assert.deepEqual(r.por_pessoa, { marta: 2, caio: 1 });
    assert.equal(l.resumo('2026-11-07').linhas, 2);
    const csv = l.csv(l.filtrar({}));
    const linhas = csv.split('\r\n').filter(Boolean);
    assert.equal(linhas.length, 4);
    assert.equal(linhas[0], 'quando,agente,pessoa,papel,fonte,escopo,operacao,acao,decisao,motivo,status,itens,bytes,aprovacao,por');
    assert.ok(linhas[1].includes('"a pessoa ""caio"", com vírgula, nega"'), linhas[1]);
    assert.ok(csv.includes('2026-11-08T12:00:00.000Z,ana,marta,r,clientes,,listar,,permitido,ok,200,2,100,,'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
