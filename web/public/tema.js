'use strict';
/* tema.js: aplica o tema (claro, escuro ou o do aparelho) ANTES da primeira pintura, em toda tela.
   Vai no <head>, logo depois do tema.css. A escolha fica no aparelho (localStorage "dgclaw-tema", a MESMA
   chave e os mesmos valores que o painel do agente em /p/<slug>/ já usava: uma escolha vale nos dois); sem
   escolha, vale o prefers-color-scheme. Expõe window.DGTema = { atual(), escolha(), define(valor), monta(el) }.
   O <meta name="theme-color"> acompanha, para a barra do navegador no celular não ficar clara no escuro. */
(function (raiz) {
  const CHAVE = 'dgclaw-tema';
  const VALIDOS = ['claro', 'escuro', 'sistema'];
  const COR = { claro: '#2f9e5e', escuro: '#0f1713' };
  const html = document.documentElement;
  const mq = raiz.matchMedia ? raiz.matchMedia('(prefers-color-scheme: dark)') : null;

  function escolha() {
    try { const v = localStorage.getItem(CHAVE); return VALIDOS.includes(v) ? v : 'sistema'; } catch (e) { return 'sistema'; }
  }
  /* o tema que está valendo de fato: 'claro' ou 'escuro' */
  function atual() {
    const e = escolha();
    if (e !== 'sistema') return e;
    return mq && mq.matches ? 'escuro' : 'claro';
  }
  function aplica() {
    const e = escolha();
    if (e === 'sistema') html.removeAttribute('data-tema'); else html.setAttribute('data-tema', e);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', COR[atual()]);
    document.dispatchEvent(new CustomEvent('dgclaw:tema', { detail: { escolha: e, atual: atual() } }));
  }
  function define(valor) {
    const v = VALIDOS.includes(valor) ? valor : 'sistema';
    try { if (v === 'sistema') localStorage.removeItem(CHAVE); else localStorage.setItem(CHAVE, v); } catch (e) { /* sem armazenamento: vale só nesta página */ }
    aplica();
  }
  /* monta o seletor dentro de `el`: três botões; o escolhido fica marcado */
  function monta(el) {
    if (!el) return;
    el.classList.add('tema-seletor');
    el.innerHTML = '';
    for (const [v, rotulo] of [['claro', 'Claro'], ['escuro', 'Escuro'], ['sistema', 'Como o aparelho']]) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = rotulo; b.dataset.tema = v;
      b.setAttribute('aria-pressed', String(escolha() === v));
      b.addEventListener('click', () => { define(v); el.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.tema === v))); });
      el.appendChild(b);
    }
  }

  aplica();
  if (mq && mq.addEventListener) mq.addEventListener('change', () => { if (escolha() === 'sistema') aplica(); });
  raiz.addEventListener('storage', ev => { if (ev.key === CHAVE) aplica(); });
  raiz.DGTema = { atual, escolha, define, monta, CHAVE };
})(window);
