'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validaBases, criarBases } = require('../lib/bases');
const { pastaTemp, capturaLog } = require('./ajuda');

const EXEMPLO = {
  versao: 1,
  bases: {
    'manual-rh': { nome: 'Manual do RH', escopo: 'empresa', dono: 'rh', classificacao: 'interno', finalidade: 'procedimentos', retencao_dias: 0 },
    'contratos-x': { escopo: 'grupo', grupo: 'projeto-x', classificacao: 'sensivel' },
    'notas-marta': { escopo: 'privada', pessoa: 'marta' },
    'faq-site': { escopo: 'publica' },
  },
};

test('validaBases aceita o exemplo e preenche os padrões do catálogo', () => {
  const r = validaBases(EXEMPLO);
  assert.equal(r.ok, true, JSON.stringify(r.erros));
  assert.deepEqual(r.bases['manual-rh'], { nome: 'Manual do RH', escopo: 'empresa', grupo: null, pessoa: null, dono: 'rh', classificacao: 'interno', finalidade: 'procedimentos', retencao_dias: 0 });
  assert.equal(r.bases['contratos-x'].grupo, 'projeto-x'); assert.equal(r.bases['contratos-x'].nome, 'contratos-x');
  assert.equal(r.bases['notas-marta'].pessoa, 'marta'); assert.equal(r.bases['notas-marta'].classificacao, 'interno');
  assert.equal(r.bases['faq-site'].classificacao, 'publico'); assert.equal(r.bases['faq-site'].dono, 'nao-informado');
});

test('validaBases recusa escopo errado, grupo/pessoa fora do lugar, nomes e campos inválidos', () => {
  const casos = [
    [null, /objeto JSON/],
    [{ versao: 2 }, /"versao" precisa ser 1/],
    [{ versao: 1, bases: { 'Manual': { escopo: 'empresa' } } }, /nome "Manual" não vale/],
    [{ versao: 1, bases: { m: { escopo: 'todos' } } }, /escopo precisa ser um de/],
    [{ versao: 1, bases: { m: { escopo: 'grupo' } } }, /exige o campo "grupo"/],
    [{ versao: 1, bases: { m: { escopo: 'empresa', grupo: 'x' } } }, /"grupo" só faz sentido/],
    [{ versao: 1, bases: { m: { escopo: 'privada' } } }, /exige o campo "pessoa"/],
    [{ versao: 1, bases: { m: { escopo: 'empresa', pessoa: 'x' } } }, /"pessoa" só faz sentido/],
    [{ versao: 1, bases: { m: { escopo: 'empresa', senha: 'x' } } }, /campo desconhecido "senha"/],
    [{ versao: 1, bases: { m: { escopo: 'empresa', classificacao: 'ultra' } } }, /classificacao precisa ser/],
    [{ versao: 1, bases: { m: { escopo: 'empresa', retencao_dias: -1 } } }, /retencao_dias/],
    [{ versao: 1, bases: { m: { escopo: 'empresa', nome: 'a\u0000b' } } }, /nome precisa ser um texto/],
  ];
  for (const [entrada, rx] of casos) {
    const r = validaBases(entrada);
    assert.equal(r.ok, false, JSON.stringify(entrada));
    assert.ok(r.erros.some((e) => rx.test(e)), `esperava ${rx} em ${JSON.stringify(r.erros)}`);
  }
});

test('criarBases: ausente é vazio e válido; inválido fecha; corrigir reabre', () => {
  const dir = pastaTemp('bases');
  const arq = path.join(dir, 'bases.json');
  const cap = capturaLog();
  const b = criarBases({ caminho: arq, log: cap.log });
  try {
    assert.equal(b.estado().ok, true); assert.equal(b.estado().origem, 'ausente'); assert.equal(b.obter('manual-rh'), null);
    fs.writeFileSync(arq, '{ nope');
    assert.equal(b.estado().ok, false); assert.match(b.estado().erro, /não é JSON válido/); assert.equal(b.obter('manual-rh'), null);
    fs.writeFileSync(arq, JSON.stringify(EXEMPLO));
    assert.equal(b.estado().ok, true); assert.equal(b.obter('manual-rh').escopo, 'empresa');
    assert.match(cap.texto(), /Bases de conhecimento carregadas .*4 base\(s\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
