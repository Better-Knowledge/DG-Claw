'use strict';
// Tela /observabilidade: arquivos ligados, menu, service worker e as funções puras que montam o HTML.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../public/menu-lado');
const T = require('../public/observabilidade');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');

test('o menu lateral tem a entrada Observabilidade e os estáticos estão no service worker', () => {
  assert.deepEqual(M.LINK_OBSERVABILIDADE, { nome: 'Observabilidade', ico: '📈', href: '/observabilidade' });
  assert.match(pub('menu-lado.js'), /data-tour="gm-observabilidade"/);
  const h = pub('observabilidade.html');
  for (const u of ['/observabilidade.js', '/observabilidade.css', '/casca.js', '/menu-lado.js', '/tour.js']) assert.ok(h.includes(u), u);
  assert.match(h, /DGCasca\.monta\(\{ pagina: 'observabilidade'/);
  const s = pub('sw.js');
  assert.match(s, /dgclaw-estaticos-v(3[6-9]|[4-9][0-9])\b/);
  for (const u of ['/observabilidade.js', '/observabilidade.css']) assert.ok(s.includes(`'${u}'`), u);
});

test('resumo, barras e linhas viram HTML seguro; a query leva só o que foi preenchido', () => {
  const tiles = T.htmlTiles({ linhas: 12, desde: '2026-10-09', por_decisao: { permitido: 9, negado: 3 } });
  assert.ok(tiles.includes('12') && tiles.includes('permitidos') && tiles.includes('ob-tile negado'));
  const barras = T.htmlBarras({ 'ana<x>': 5, bia: 1 });
  assert.ok(barras.includes('ana&lt;x&gt;') && barras.indexOf('ana&lt;x&gt;') < barras.indexOf('bia'), 'maior primeiro, escapado');
  assert.match(T.htmlBarras({}), /nada/);
  assert.ok(fs.readFileSync(path.join(__dirname, '../public/observabilidade.html'), 'utf8').includes('id="porAgenteSistema"'), 'a coluna de sistemas por agente');
  assert.ok(fs.readFileSync(path.join(__dirname, '../public/observabilidade.js'), 'utf8').includes('por_agente_sistema'));
  const linhas = T.htmlLinhas([{ quando: '2026-11-08T12:00:00.000Z', agente: 'ana', pessoa: 'marta', papel: 'recepcao', fonte: 'folha', operacao: 'listar', decisao: 'negado', status: 403, motivo: 'o papel <recepcao> nega' }]);
  assert.ok(linhas.includes('&lt;recepcao&gt;') && linhas.includes('class="negado"') && linhas.includes('marta · recepcao'));
  assert.match(T.htmlLinhas([]), /Nenhum acesso/);
  assert.equal(T.montaQuery({ agente: ' ana ', pessoa: '', fonte: 'clientes', decisao: 'negado', desde: '2026-11-01', ate: '' }), 'agente=ana&fonte=clientes&decisao=negado&desde=2026-11-01&limit=200');
  for (const k of ['resumo', 'linhas']) { const p = T.PASSOS[k]; assert.ok(p.alvo && p.titulo && p.oque && p.como && p.porque, k); }
});
