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

// Nomes de cor do CSS que não são tokens. Minúsculas ou maiúsculas, só como palavra inteira.
const NOMES_DE_COR = ['aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black', 'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow', 'yellowgreen'].join('|');
const FUNCOES_DE_COR = 'rgba?|hsla?|hwb|lab|lch|oklab|oklch|color';
const RX_COR_FIXA = new RegExp('#[0-9a-f]{3,8}\\b|%23[0-9a-f]{3,8}\\b|\\b(' + FUNCOES_DE_COR + ')\\(|(?<![\\w-])(' + NOMES_DE_COR + ')(?![\\w-])', 'i');
// JS e HTML: cor fixa em estilo inline (style="...", el.style.x = '#...', setAttribute('style', ...), style.setProperty(...)).
// A cor do agente vinda do registro (a.cor || '#2f9e5e') e os desenhos do onboarding (canvas) são exceções marcadas na linha.
const VALOR_DE_COR = '(#[0-9a-f]{3,8}\\b|\\b(' + FUNCOES_DE_COR + ')\\(|(?<![\\w-])(' + NOMES_DE_COR + ')(?![\\w-]))';
const RX_COR_EM_CODIGO = new RegExp('(style\\s*=\\s*\\\\?["\'`][^"\'`]*' + VALOR_DE_COR + ')|(\\.style\\.[a-zA-Z]+\\s*=\\s*[\'"`][^\'"`]*' + VALOR_DE_COR + ')|(setAttribute\\(\\s*[\'"]style[\'"][^)]*' + VALOR_DE_COR + ')|(\\.style\\.setProperty\\([^)]*' + VALOR_DE_COR + ')', 'i');

test('nenhum CSS de tela tem cor fixa fora dos tokens (salvo linha marcada com cor-fixa)', () => {
  const achados = [];
  for (const nome of fs.readdirSync(PUB).filter((n) => n.endsWith('.css') && !SEM_TOKENS.has(n))) {
    const cru = pub(nome).split('\n');
    const css = pub(nome).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    css.split('\n').forEach((linha, i) => {
      if (/cor-fixa/.test(cru[i])) return;
      if (RX_COR_FIXA.test(linha)) achados.push(`${nome}:${i + 1}: ${linha.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(achados, [], `Cor fixa fora de tema.css (troque por um token --t-* ou marque a linha com /* cor-fixa: motivo */):\n${achados.join('\n')}`);
});

test('nenhum JS ou HTML de tela pinta cor fixa em estilo inline ou em <style> (salvo cor-fixa ou a cor do agente do registro)', () => {
  const achados = [];
  for (const nome of fs.readdirSync(PUB).filter((n) => (n.endsWith('.js') || n.endsWith('.html')) && !['dgvis.js', 'sw.js', 'tema.js'].includes(n))) {
    const texto = pub(nome);
    texto.split('\n').forEach((linha, i) => {
      if (/cor-fixa/.test(linha) || /\|\|\s*'#2f9e5e'/.test(linha)) return;
      if (RX_COR_EM_CODIGO.test(linha)) achados.push(`${nome}:${i + 1}: ${linha.trim().slice(0, 100)}`);
    });
    // o miolo de cada <style> de um HTML é CSS: vale a mesma regra dos arquivos .css
    if (nome.endsWith('.html')) for (const m of texto.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
      const antes = texto.slice(0, m.index).split('\n').length;
      const crus = m[1].split('\n'); // a marca cor-fixa fica num comentário, então é lida na linha crua, antes de apagá-los
      m[1].replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).split('\n').forEach((linha, i) => {
        if (/cor-fixa/.test(crus[i])) return;
        if (RX_COR_FIXA.test(linha)) achados.push(`${nome}:${antes + i}: <style> ${linha.trim().slice(0, 90)}`);
      });
    }
  }
  assert.deepEqual(achados, [], `Cor fixa em estilo inline (use uma classe com token; marque com cor-fixa só o que for de marca ou desenho):\n${achados.join('\n')}`);
});

test('o seletor de tema está no menu (Configurações), inclusive para o colaborador', () => {
  assert.ok(pub('casca.js').includes('id="mlTemaSeletor"'));
  assert.ok(pub('menu-lado.js').includes("raiz.DGTema.monta($('mlTemaSeletor'))"));
  // o bloco Configurações do menu não é só do dono: o colaborador também escolhe o tema
  assert.ok(!/papel-colab[^\n]*mlTemaSeletor/.test(pub('papel.css')), 'papel.css não esconde o seletor do colaborador');
});
