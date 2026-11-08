'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validaPapeis, criarPapeis } = require('../lib/papeis');
const { pastaTemp, capturaLog } = require('./ajuda');

const EXEMPLO = {
  versao: 1,
  pessoas: {
    marta: { nome: 'Marta', fontes: { agenda: 'leitura', clientes: { nivel: 'leitura', campos: ['nome', 'telefone', 'email'] } }, acoes: { enviar_email: 'aprovacao_humana' } },
    caio: { fontes: { folha: 'leitura' } },
  },
  papeis: {
    recepcao: { fontes: { agenda: 'leitura', clientes: { nivel: 'leitura', campos: ['nome', 'telefone'] }, folha: 'negado' }, acoes: { enviar_email: 'aprovacao_humana', apagar_arquivo: 'negado' } },
    analista: { fontes: { agenda: 'leitura' } },
  },
  agentes: { ana: { pessoa: 'marta', papel: 'recepcao' }, bia: { pessoa: 'caio', papel: 'analista' } },
};

test('validaPapeis aceita o exemplo e normaliza fontes para { nivel, campos }', () => {
  const r = validaPapeis(EXEMPLO);
  assert.equal(r.ok, true, JSON.stringify(r.erros));
  assert.deepEqual(r.politica.papeis.recepcao.fontes.clientes, { nivel: 'leitura', campos: ['nome', 'telefone'] });
  assert.deepEqual(r.politica.papeis.recepcao.fontes.agenda, { nivel: 'leitura', campos: null });
  assert.deepEqual(r.politica.pessoas.caio, { nome: 'caio', fontes: { folha: { nivel: 'leitura', campos: null } }, acoes: {} });
  assert.deepEqual(r.politica.agentes.ana, { pessoa: 'marta', papel: 'recepcao' });
});

test('validaPapeis recusa o que não está no contrato, com uma frase por problema', () => {
  const casos = [
    [null, /objeto JSON/],
    [{ versao: 2 }, /"versao" precisa ser 1/],
    [{ versao: 1, extra: 1 }, /campo desconhecido "extra"/],
    [{ versao: 1, pessoas: { 'Marta': {} } }, /nome "Marta" não vale/],
    [{ versao: 1, pessoas: { marta: { senha: 'x' } } }, /pessoas.marta tem o campo desconhecido "senha"/],
    [{ versao: 1, pessoas: { marta: { fontes: { agenda: 'escrita' } } } }, /nível "escrita" não existe/],
    [{ versao: 1, pessoas: { marta: { fontes: { agenda: { nivel: 'negado', campos: ['x'] } } } } }, /"campos" não faz sentido com nível "negado"/],
    [{ versao: 1, pessoas: { marta: { fontes: { agenda: { nivel: 'leitura', campos: ['Nome Completo'] } } } } }, /lista de até 100 nomes de campo/],
    [{ versao: 1, papeis: { r: { acoes: { enviar_email: 'livre' } } } }, /nível "livre" não existe.*não há "livre"/],
    [{ versao: 1, agentes: { ana: { pessoa: 'marta', papel: 'r' } } }, /pessoa aponta para "marta", que não existe/],
    [{ versao: 1, pessoas: { marta: {} }, agentes: { ana: { pessoa: 'marta', papel: 'r' } } }, /papel aponta para "r", que não existe/],
    [{ versao: 1, pessoas: { marta: {} }, papeis: { r: {} }, agentes: { ana: { pessoa: 'marta' } } }, /agentes.ana.papel é obrigatório/],
    [{ versao: 1, pessoas: { marta: {} }, papeis: { r: {} }, agentes: { admin: { pessoa: 'marta', papel: 'r' } } }, /Admin não entra/],
    [{ versao: 1, agentes: { 'Ana!': { pessoa: 'm', papel: 'r' } } }, /slug "Ana!" não vale/],
    [{ versao: 1, pessoas: { marta: {} }, papeis: { r: {} }, agentes: { dono: { pessoa: 'marta', papel: 'r' } } }, /"dono" é reservado/],
    [{ versao: 1, pessoas: { marta: { fontes: { 'a/b': 'leitura' } } } }, /nome "a\/b" não vale/],
  ];
  for (const [entrada, rx] of casos) {
    const r = validaPapeis(entrada);
    assert.equal(r.ok, false, `devia recusar ${JSON.stringify(entrada)}`);
    assert.ok(r.erros.some((e) => rx.test(e)), `esperava ${rx} em ${JSON.stringify(r.erros)}`);
  }
});

test('validaPapeis junta vários problemas em vez de parar no primeiro', () => {
  const r = validaPapeis({ versao: 3, pessoas: { 'X': {} }, papeis: 5, agentes: { ana: {} } });
  assert.equal(r.ok, false);
  assert.ok(r.erros.length >= 4, JSON.stringify(r.erros));
});

test('criarPapeis: ausente é política vazia e válida; inválido fecha; corrigir reabre sem reiniciar', () => {
  const dir = pastaTemp('papeis');
  const arq = path.join(dir, 'papeis.json');
  const cap = capturaLog();
  const p = criarPapeis({ caminho: arq, log: cap.log });
  try {
    let e = p.estado();
    assert.equal(e.ok, true); assert.equal(e.origem, 'ausente'); assert.deepEqual(e.politica.agentes, {});
    assert.equal(p.deAgente('ana'), null);
    assert.match(cap.texto(), /não existe .*papeis.json/);

    fs.writeFileSync(arq, '{ isto não é json');
    e = p.estado();
    assert.equal(e.ok, false); assert.match(e.erro, /não é JSON válido/); assert.match(e.erro, /todo acesso a dados está negado/);
    assert.equal(p.deAgente('ana'), null, 'com o arquivo inválido ninguém tem papel');
    assert.match(cap.texto(), /\[erro\] Papéis de dados: .*não é JSON válido/);

    fs.writeFileSync(arq, JSON.stringify({ versao: 1, pessoas: { marta: {} }, papeis: { r: {} }, agentes: { ana: { pessoa: 'ninguem', papel: 'r' } } }));
    // mtime pode coincidir com a escrita anterior no mesmo milissegundo: força a assinatura a mudar pelo tamanho
    e = p.estado();
    assert.equal(e.ok, false); assert.match(e.erro, /1 problema\(s\): agentes.ana.pessoa aponta para "ninguem"/);

    fs.writeFileSync(arq, JSON.stringify(EXEMPLO, null, 2));
    e = p.estado();
    assert.equal(e.ok, true, e.erro); assert.equal(e.origem, 'arquivo');
    assert.match(e.hash, /^[0-9a-f]{12}$/);
    assert.deepEqual(p.deAgente('ana'), { pessoa: 'marta', papel: 'recepcao' });
    assert.equal(p.deAgente('zed'), null);
    assert.match(cap.texto(), /Papéis de dados carregados .*sha256 [0-9a-f]{12}, modificado em \d{4}-.*: 2 pessoa\(s\), 2 papel\(is\), 2 agente\(s\)/);

    // o mesmo erro repetido não enche o log
    const antes = cap.linhas.length;
    p.estado(); p.estado();
    assert.equal(cap.linhas.length, antes);

    // troca por uma cópia com o MESMO tamanho e o MESMO mtime (cp -p): ainda é vista, pelo inode/ctime
    const copia = JSON.stringify(EXEMPLO, null, 2).replace('"recepcao"', '"recepcap"');
    const st = fs.statSync(arq);
    fs.writeFileSync(arq + '.novo', copia); fs.utimesSync(arq + '.novo', st.atime, st.mtime); fs.renameSync(arq + '.novo', arq);
    assert.equal(Math.round(fs.statSync(arq).mtimeMs / 1000), Math.round(st.mtimeMs / 1000)); assert.equal(fs.statSync(arq).size, st.size);
    assert.equal(p.estado().ok, false, 'a cópia aponta para um papel que não existe e foi lida mesmo com mtime e tamanho iguais');
    fs.writeFileSync(arq, JSON.stringify(EXEMPLO, null, 2));
    assert.equal(p.estado().ok, true);
    // apagar o arquivo volta ao vazio
    fs.unlinkSync(arq);
    e = p.estado();
    assert.equal(e.ok, true); assert.equal(e.origem, 'ausente'); assert.equal(p.deAgente('ana'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('o exemplo que o instalador grava é válido e nega tudo por padrão', () => {
  const texto = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'papeis.exemplo.json'), 'utf8');
  const r = validaPapeis(JSON.parse(texto));
  assert.equal(r.ok, true, JSON.stringify(r.erros));
  assert.deepEqual(r.politica.agentes, {}, 'o exemplo não libera agente nenhum: o dono acrescenta os seus');
  assert.ok(Object.keys(r.politica.papeis).length >= 1, 'traz ao menos um papel de modelo para copiar');
});
