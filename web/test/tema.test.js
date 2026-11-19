'use strict';
// Tema claro e escuro por pessoa (ds/tema.js): o tema da marca é o padrão, a escolha fica no aparelho e vale antes da
// primeira pintura; o seletor fica no menu; nenhuma cor fixa fora do ds/tokens.css (uma cor fixa não acompanha o tema).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUB = path.join(__dirname, '..', 'public');
const pub = (n) => fs.readFileSync(path.join(PUB, n), 'utf8');

/* Um documento de mentira só com o que o tema.js toca: <html data-tema>, <meta theme-color>, eventos e localStorage. */
function mundo({ marca = 'claro', guardado = null, aparelhoEscuro = false, semStorage = false } = {}) {
  const attrs = { 'data-tema': marca };
  const meta = { conteudo: '#AABBCC', getAttribute: () => meta.conteudo, setAttribute: (k, v) => { meta.conteudo = v; } };
  const ouvintes = {};
  const doc = {
    documentElement: { getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { attrs[k] = v; } },
    querySelector: (sel) => (sel === 'meta[name="theme-color"]' ? meta : null),
    addEventListener: (n, f) => { (ouvintes[n] = ouvintes[n] || []).push(f); },
    dispatchEvent: (ev) => { (ouvintes[ev.type] || []).forEach((f) => f(ev)); return true; },
    createElement: (tag) => {
      const el = { tag, atributos: {}, filhos: [], ouvintes: {}, textContent: '', className: '', type: '', title: '',
        setAttribute(k, v) { this.atributos[k] = v; }, getAttribute(k) { return k in this.atributos ? this.atributos[k] : null; },
        addEventListener(n, f) { this.ouvintes[n] = f; }, click() { this.ouvintes.click(); } };
      return el;
    },
  };
  const store = new Map(); if (guardado) store.set('dgclaw-tema', guardado);
  const localStorage = semStorage
    ? { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); }, removeItem() { throw new Error('bloqueado'); } }
    : { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const mq = { matches: aparelhoEscuro, ouvinte: null, addEventListener: (n, f) => { mq.ouvinte = f; } };
  const janela = {
    document: doc, localStorage, matchMedia: () => mq, ouvintes: {},
    addEventListener: (n, f) => { janela.ouvintes[n] = f; },
    getComputedStyle: () => ({ getPropertyValue: () => (attrs['data-tema'] === 'escuro' ? '#0F141B' : '#F3F5F8') }),
  };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  const ctx = vm.createContext({ window: janela, document: doc, localStorage, CustomEvent, console });
  vm.runInContext(pub('ds/tema.js'), ctx);
  return { attrs, meta, mq, janela, store, doc, T: janela.DGTema };
}

test('sem escolha guardada vale o tema da marca, e o theme-color da marca fica como veio', () => {
  const claro = mundo({ marca: 'claro' });
  assert.equal(claro.attrs['data-tema'], 'claro'); assert.equal(claro.T.atual(), 'claro'); assert.equal(claro.T.escolha(), ''); assert.equal(claro.meta.conteudo, '#AABBCC');
  const escuro = mundo({ marca: 'escuro', aparelhoEscuro: false });
  assert.equal(escuro.attrs['data-tema'], 'escuro', 'a marca escura vale mesmo com o aparelho claro');
  const aparelho = mundo({ marca: 'claro', aparelhoEscuro: true });
  assert.equal(aparelho.attrs['data-tema'], 'claro', 'o aparelho escuro NÃO liga o escuro sozinho: quem decide é a marca');
});

test('a escolha guardada vence a marca; "sistema" segue o aparelho e acompanha a mudança dele', () => {
  const m = mundo({ marca: 'claro', guardado: 'escuro' });
  assert.equal(m.attrs['data-tema'], 'escuro'); assert.equal(m.meta.conteudo, '#0F141B', 'o theme-color vira o fundo do escuro');
  const s = mundo({ marca: 'escuro', guardado: 'sistema', aparelhoEscuro: false });
  assert.equal(s.attrs['data-tema'], 'claro');
  s.mq.matches = true; s.mq.ouvinte();
  assert.equal(s.attrs['data-tema'], 'escuro');
  const lixo = mundo({ marca: 'claro', guardado: 'roxo' });
  assert.equal(lixo.T.escolha(), '', 'valor desconhecido no storage conta como sem escolha');
});

test('define() grava, aplica e avisa; "" ou valor inválido apaga a escolha e volta à marca; storage bloqueado não derruba', () => {
  const m = mundo({ marca: 'claro' });
  const vistos = [];
  m.doc.addEventListener('dgclaw:tema', (ev) => vistos.push(ev.detail));
  m.T.define('escuro');
  assert.equal(m.store.get('dgclaw-tema'), 'escuro'); assert.equal(m.attrs['data-tema'], 'escuro');
  assert.deepEqual(JSON.parse(JSON.stringify(vistos.at(-1))), { escolha: 'escuro', atual: 'escuro', marca: 'claro' });
  m.T.define('qualquer coisa');
  assert.equal(m.store.has('dgclaw-tema'), false); assert.equal(m.attrs['data-tema'], 'claro'); assert.equal(m.meta.conteudo, '#AABBCC');
  // outra aba trocou: o evento storage reaplica
  m.store.set('dgclaw-tema', 'escuro'); m.janela.ouvintes.storage({ key: 'dgclaw-tema' });
  assert.equal(m.attrs['data-tema'], 'escuro');
  const b = mundo({ semStorage: true });
  b.T.define('escuro');
  assert.equal(b.attrs['data-tema'], 'claro', 'sem storage a escolha não fica, e nada quebra');
});

test('monta(): quatro botões (Padrão, Claro, Escuro, Como o aparelho), o escolhido marcado, e o clique troca', () => {
  const m = mundo({ marca: 'escuro', guardado: 'claro' });
  const el = { filhos: [], textContent: 'x', appendChild(b) { this.filhos.push(b); }, querySelectorAll() { return this.filhos; } };
  m.T.monta(el);
  assert.deepEqual(el.filhos.map((b) => b.textContent), ['Padrão', 'Claro', 'Escuro', 'Como o aparelho']);
  assert.deepEqual(el.filhos.map((b) => b.getAttribute('aria-pressed')), ['false', 'true', 'false', 'false']);
  assert.match(el.filhos[0].title, /escuro/, 'o Padrão diz qual é o tema da marca');
  el.filhos[3].click();
  assert.equal(m.store.get('dgclaw-tema'), 'sistema'); assert.equal(el.filhos[3].getAttribute('aria-pressed'), 'true'); assert.equal(el.filhos[1].getAttribute('aria-pressed'), 'false');
  el.filhos[0].click();
  assert.equal(m.store.has('dgclaw-tema'), false); assert.equal(m.attrs['data-tema'], 'escuro', 'Padrão volta ao tema da marca');
  for (const b of el.filhos) { assert.equal(b.type, 'button'); assert.equal(b.className, 'ml-tema-op'); }
});

test('toda página com o tokens.css carrega o ds/tema.js logo depois dele e antes de qualquer script de tela', () => {
  let n = 0;
  for (const nome of fs.readdirSync(PUB).filter((f) => f.endsWith('.html'))) {
    const h = pub(nome);
    const iTokens = h.indexOf('href="/ds/tokens.css"');
    if (iTokens < 0) continue;
    n++;
    const iTema = h.indexOf('<script src="/ds/tema.js"></script>');
    assert.ok(iTema > iTokens, `${nome}: falta o ds/tema.js depois do tokens.css`);
    const primeiroScript = [...h.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]).filter((s) => !/^\/ds\/(contraste|tema)\.js$/.test(s))[0];
    assert.ok(h.indexOf(`<script src="${primeiroScript}"`) > iTema, `${nome}: ${primeiroScript} vem antes do tema.js`);
    assert.ok(iTema < h.indexOf('<body'), `${nome}: o tema.js precisa estar no <head>`);
  }
  assert.ok(n >= 14, `só ${n} páginas com tokens.css`);
});

test('o menu tem a linha Tema (casca.js) e o menu-lado.js monta o seletor; o sw guarda o tema.js; tokens.css declara color-scheme', () => {
  const casca = pub('casca.js');
  assert.match(casca, /id="mlTema"[^>]*data-tour="gm-tema"/);
  assert.match(casca, /id="mlTemaSeletor" role="group" aria-labelledby="mlTemaRotulo"/);
  assert.match(pub('menu-lado.js'), /raiz\.DGTema\.monta\(\$\('mlTemaSeletor'\)\)/);
  assert.match(pub('menu-lado.css'), /\.ml-tema-op\[aria-pressed="true"\]\{background:var\(--botao-fundo\);color:var\(--botao-texto\)/);
  const sw = pub('sw.js');
  assert.ok(sw.includes("'/ds/tema.js'"));
  const tokens = pub('ds/tokens.css');
  assert.match(tokens, /:root\{\s*color-scheme:light;/); assert.match(tokens, /html\[data-tema="escuro"\]\{\s*color-scheme:dark;/);
  for (const t of ['--cor-superficie-2', '--cor-codigo-fundo', '--cor-veu-forte', '--cor-info:', '--sombra-2']) assert.ok(tokens.includes(t), t);
  assert.match(pub('conversa.js'), /addEventListener\('dgclaw:tema'/, 'os visuais abertos acompanham a troca');
});


// Nomes de cor do CSS que não são tokens. Minúsculas ou maiúsculas, só como palavra inteira.
const NOMES_DE_COR = ['aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black', 'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow', 'yellowgreen'].join('|');
const FUNCOES_DE_COR = 'rgba?|hsla?|hwb|lab|lch|oklab|oklch|color';
const RX_COR_FIXA = new RegExp('#[0-9a-f]{3,8}\\b|%23[0-9a-f]{3,8}\\b|\\b(' + FUNCOES_DE_COR + ')\\(|(?<![\\w-])(' + NOMES_DE_COR + ')(?![\\w-])', 'i');
// dgvis.css tem a própria paleta (visuais na conversa) e já troca pelo data-tema; sem-zoom.css não tem cor. O ds/ fica em subpasta (o tokens.css é o dono das cores).
const SEM_TOKENS = new Set(['dgvis.css', 'sem-zoom.css']);

test('nenhum CSS de tela tem cor fixa fora do ds/tokens.css (salvo linha marcada com cor-fixa)', () => {
  const achados = [];
  for (const nome of fs.readdirSync(PUB).filter((n) => n.endsWith('.css') && !SEM_TOKENS.has(n))) {
    const cru = pub(nome).split('\n');
    const css = pub(nome).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    css.split('\n').forEach((linha, i) => {
      if (/cor-fixa/.test(cru[i])) return;
      if (RX_COR_FIXA.test(linha)) achados.push(`${nome}:${i + 1}: ${linha.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(achados, [], `Cor fixa fora do ds/tokens.css (troque por um token --cor-*/--botao-*/... ou marque a linha com /* cor-fixa: motivo */):\n${achados.join('\n')}`);
});

// JS e HTML: cor fixa em estilo inline (style="...", el.style.x = '#...', setProperty) ou em <style>. A cor do agente
// vinda do registro (a.cor || '#2f9e5e') é a exceção, marcada pelo próprio padrão; cadeado.html e face-id.html não
// entram no tema (a tela travada não carrega os tokens); dgvis.js tem a própria paleta.
const FORA_DO_TEMA = new Set(['cadeado.html', 'face-id.html', 'dgvis.js', 'sw.js']);
const VALOR_DE_COR = '(#[0-9a-f]{3,8}\\b|\\b(' + FUNCOES_DE_COR + ')\\(|(?<![\\w-])(' + NOMES_DE_COR + ')(?![\\w-]))';
const RX_COR_EM_CODIGO = new RegExp('(style\\s*=\\s*\\\\?["\'`][^"\'`]*' + VALOR_DE_COR + ')|(\\.style\\.[a-zA-Z]+\\s*=\\s*[\'"`][^\'"`]*' + VALOR_DE_COR + ')|(setAttribute\\(\\s*[\'"]style[\'"][^)]*' + VALOR_DE_COR + ')|(\\.style\\.setProperty\\([^)]*' + VALOR_DE_COR + ')', 'i');

test('nenhum JS ou HTML de tela pinta cor fixa em estilo inline ou em <style> (salvo cor-fixa ou a cor do agente do registro)', () => {
  const achados = [];
  for (const nome of fs.readdirSync(PUB).filter((n) => (n.endsWith('.js') || n.endsWith('.html')) && !FORA_DO_TEMA.has(n))) {
    const linhas = pub(nome).split('\n');
    let emStyle = false;
    linhas.forEach((linha, i) => {
      if (/cor-fixa/.test(linha) || /\.cor \|\| '#/.test(linha)) return;
      if (/<style/.test(linha)) emStyle = true;
      if ((emStyle && RX_COR_FIXA.test(linha.replace(/\/\*[\s\S]*?\*\//g, ''))) || RX_COR_EM_CODIGO.test(linha)) achados.push(`${nome}:${i + 1}: ${linha.trim().slice(0, 90)}`);
      if (/<\/style/.test(linha)) emStyle = false;
    });
  }
  assert.deepEqual(achados, [], `Cor fixa em código de tela (use um token --cor-* ou marque a linha com cor-fixa):\n${achados.join('\n')}`);
});
