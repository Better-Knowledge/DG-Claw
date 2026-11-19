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
