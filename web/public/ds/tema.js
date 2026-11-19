'use strict';
/* tema.js: o tema (claro ou escuro) que vale para ESTA pessoa, neste aparelho, aplicado antes da primeira pintura.
   Vai no <head>, logo depois do ds/tokens.css e antes de qualquer outro script de tela.

   O servidor manda a página com o tema da marca (<html data-tema="claro|escuro">, de marca.json). Esse é o padrão.
   A pessoa pode trocar no menu ☰, em Configurações: "Claro", "Escuro" ou "Como o aparelho" (segue o modo do celular ou
   do computador). A escolha fica só neste navegador (localStorage "dgclaw-tema", a mesma chave e os mesmos valores que o
   painel do agente em /p/<slug>/ já usa: claro, escuro; "sistema" o painel trata como "sem escolha"). "Padrão" apaga a
   escolha e volta ao tema da marca. Sem escolha, nada liga sozinho pelo aparelho: quem decide é a marca.

   O <meta name="theme-color"> acompanha (barra do navegador no celular). Expõe window.DGTema =
   { atual(), escolha(), marca(), define(valor), monta(el), CHAVE } e dispara "dgclaw:tema" no document a cada troca. */
(function (raiz) {
  const CHAVE = 'dgclaw-tema';
  const VALIDOS = ['claro', 'escuro', 'sistema'];
  const doc = raiz.document;
  const html = doc.documentElement;
  const MARCA = html.getAttribute('data-tema') === 'escuro' ? 'escuro' : 'claro';
  const metaCor = doc.querySelector('meta[name="theme-color"]');
  const COR_MARCA = metaCor ? metaCor.getAttribute('content') : '';
  const mq = raiz.matchMedia ? raiz.matchMedia('(prefers-color-scheme: dark)') : null;

  /* 'claro' | 'escuro' | 'sistema' | '' (sem escolha: vale o tema da marca) */
  function escolha() {
    try { const v = localStorage.getItem(CHAVE); return VALIDOS.indexOf(v) >= 0 ? v : ''; } catch (e) { return ''; }
  }
  /* o tema que está valendo de fato: 'claro' ou 'escuro' */
  function atual() {
    const e = escolha();
    if (e === 'claro' || e === 'escuro') return e;
    if (e === 'sistema') return mq && mq.matches ? 'escuro' : 'claro';
    return MARCA;
  }
  function corDaBarra(tema) {
    if (tema === MARCA && COR_MARCA) return COR_MARCA;
    let v = '';
    try { v = raiz.getComputedStyle ? raiz.getComputedStyle(html).getPropertyValue('--cor-fundo').trim() : ''; } catch (e) { v = ''; }
    return v || (tema === 'escuro' ? '#0F141B' : '#F3F5F8');
  }
  function aplica() {
    const t = atual();
    html.setAttribute('data-tema', t);
    if (metaCor) metaCor.setAttribute('content', corDaBarra(t));
    if (typeof CustomEvent === 'function') doc.dispatchEvent(new CustomEvent('dgclaw:tema', { detail: { escolha: escolha(), atual: t, marca: MARCA } }));
  }
  /* define('claro'|'escuro'|'sistema'); qualquer outra coisa apaga a escolha e volta ao tema da marca */
  function define(valor) {
    const v = VALIDOS.indexOf(valor) >= 0 ? valor : '';
    try { if (v) localStorage.setItem(CHAVE, v); else localStorage.removeItem(CHAVE); } catch (e) { /* sem armazenamento: vale só nesta página */ }
    aplica();
  }
  /* monta o seletor dentro de `el`: quatro botões; o escolhido fica marcado (aria-pressed) */
  function monta(el) {
    if (!el) return;
    const OPCOES = [['', 'Padrão'], ['claro', 'Claro'], ['escuro', 'Escuro'], ['sistema', 'Como o aparelho']];
    el.textContent = '';
    const pinta = () => { const e = escolha(); el.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String((b.getAttribute('data-tema') || '') === e)); }); };
    OPCOES.forEach(function (par) {
      const b = doc.createElement('button');
      b.type = 'button'; b.className = 'ml-tema-op'; b.textContent = par[1]; b.setAttribute('data-tema', par[0]);
      if (!par[0]) b.title = 'O tema da marca (' + (MARCA === 'escuro' ? 'escuro' : 'claro') + ')';
      b.addEventListener('click', function () { define(par[0]); pinta(); });
      el.appendChild(b);
    });
    pinta();
    doc.addEventListener('dgclaw:tema', pinta);
  }

  aplica();
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (escolha() === 'sistema') aplica(); });
  raiz.addEventListener('storage', function (ev) { if (ev.key === CHAVE) aplica(); });
  raiz.DGTema = { atual: atual, escolha: escolha, marca: function () { return MARCA; }, define: define, monta: monta, CHAVE: CHAVE };
})(window);
