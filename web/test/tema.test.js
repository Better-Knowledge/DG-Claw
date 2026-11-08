'use strict';
// Tema claro e escuro: tokens em tema.css, tema.js antes da primeira pintura em toda tela, e nenhuma cor fixa fora
// dos tokens (uma cor fixa num CSS de tela não acompanha o tema). Linha com o marcador `cor-fixa` é exceção consciente.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');
const pub = (n) => fs.readFileSync(path.join(PUB, n), 'utf8');
// dgvis.css tem a própria paleta (visuais na conversa) e já troca pelo data-tema; sem-zoom.css não tem cor.
const SEM_TOKENS = new Set(['tema.css', 'dgvis.css', 'sem-zoom.css']);

test('tema.css define os tokens nos dois temas e tema.js vem antes da primeira folha de estilo em toda tela', () => {
  const css = pub('tema.css');
  for (const t of ['--t-fundo', '--t-superficie', '--t-texto', '--t-fraco', '--t-linha', '--t-acento', '--t-sobre-acento', '--t-ok', '--t-aviso', '--t-erro', '--t-info', '--t-sombra', '--t-veu']) {
    assert.ok(css.includes(`${t}:`), t);
  }
  assert.match(css, /html\[data-tema="escuro"\]\s*\{/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)\s*\{\s*html:not\(\[data-tema="claro"\]\)/);
  assert.match(css, /color-scheme: dark/);
  for (const nome of fs.readdirSync(PUB).filter((n) => n.endsWith('.html'))) {
    const h = pub(nome);
    const iTema = h.indexOf('<script src="/tema.js"></script>');
    const iCss = h.indexOf('<link rel="stylesheet"');
    assert.ok(iTema > 0, `${nome}: falta o tema.js`);
    assert.ok(h.indexOf('<link rel="stylesheet" href="/tema.css">') > 0, `${nome}: falta o tema.css`);
    assert.ok(iCss === -1 || h.indexOf('<link rel="stylesheet" href="/tema.css">') <= iCss, `${nome}: o tema.css precisa ser a primeira folha`);
    assert.ok(iTema < h.indexOf('<body'), `${nome}: o tema.js precisa estar no <head>`);
  }
  const js = pub('tema.js');
  assert.match(js, /localStorage\.getItem\(CHAVE\)/); assert.match(js, /setAttribute\('data-tema'/); assert.match(js, /theme-color/);
  const sw = pub('sw.js');
  assert.match(sw, /dgclaw-estaticos-v(3[8-9]|[4-9][0-9])\b/); assert.ok(sw.includes("'/tema.css'") && sw.includes("'/tema.js'"));
});

test('nenhum CSS de tela tem cor fixa fora dos tokens (salvo linha marcada com cor-fixa)', () => {
  const achados = [];
  for (const nome of fs.readdirSync(PUB).filter((n) => n.endsWith('.css') && !SEM_TOKENS.has(n))) {
    const css = pub(nome).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    css.split('\n').forEach((linha, i) => {
      if (/cor-fixa/.test(pub(nome).split('\n')[i])) return;
      // nomes de cor só como valor ("white"), nunca dentro de outra palavra ("white-space")
      if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|(?<![\w-])(white|black|red|blue|green|yellow|orange|gray|grey)(?![\w-])/.test(linha)) achados.push(`${nome}:${i + 1}: ${linha.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(achados, [], `Cor fixa fora de tema.css (troque por um token --t-* ou marque a linha com /* cor-fixa: motivo */):\n${achados.join('\n')}`);
});

test('o seletor de tema está no menu e na conta', () => {
  assert.ok(pub('casca.js').includes('id="mlTemaSeletor"'));
  assert.ok(pub('menu-lado.js').includes("raiz.DGTema.monta($('mlTemaSeletor'))"));
  assert.ok(pub('conta.html').includes('id="temaSeletor"'));
  assert.ok(pub('conta.js').includes('DGTema.monta'));
});
