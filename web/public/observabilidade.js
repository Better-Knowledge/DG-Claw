'use strict';
/* observabilidade.js: a tela /observabilidade. Mostra o uso dos dados pelos agentes (quem leu o quê, quando,
   com qual decisão), com resumo por agente, fonte e pessoa, filtros e CSV. Tudo pela API
   (web/docs/OBSERVABILIDADE.md); nada de conteúdo de dado, porque o log não o tem.
   As funções que só montam HTML ficam fora do DOM e têm teste em web/test/observabilidade-tela.test.js. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGObservabilidadeTela = m;
})(this, function (raiz) {
  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ROTULO = { permitido: 'permitidos', negado: 'negados', aprovacao: 'aprovações pedidas', executada: 'executadas', recusada: 'recusadas', falhou: 'falharam', revogada: 'revogadas' };

  function fmt(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '-';
    const p = n => String(n).padStart(2, '0');
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* As contagens de um objeto {chave: n} em barras, da maior para a menor, até `max` linhas. */
  function htmlBarras(obj, max) {
    const pares = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, max || 12);
    if (!pares.length) return '<p class="lp-vazio">nada</p>';
    const maior = pares[0][1] || 1;
    return pares.map(([k, v]) => '<div class="ob-barra"><span class="b" style="width:' + Math.max(4, Math.round(100 * v / maior)) + 'px"></span><span class="k">' + esc(k) + '</span><span class="v">' + esc(String(v)) + '</span></div>').join('');
  }

  function htmlTiles(r) {
    const d = r.por_decisao || {};
    const ordem = ['permitido', 'negado', 'aprovacao', 'executada', 'recusada', 'falhou', 'revogada'];
    const tiles = ['<div class="ob-tile"><div class="n">' + esc(String(r.linhas || 0)) + '</div><div class="r">pedidos desde ' + esc(r.desde || '') + '</div></div>'];
    for (const k of ordem) if (d[k]) tiles.push('<div class="ob-tile ' + esc(k) + '"><div class="n">' + esc(String(d[k])) + '</div><div class="r">' + esc(ROTULO[k] || k) + '</div></div>');
    return tiles.join('');
  }

  function htmlLinhas(linhas) {
    if (!linhas || !linhas.length) return '<p class="lp-vazio">Nenhum acesso com esses filtros.</p>';
    const tr = linhas.map(l => '<tr><td>' + esc(fmt(l.quando)) + '</td><td>' + esc(l.agente || '') + (l.pessoa ? '<br><small>' + esc(l.pessoa) + ' · ' + esc(l.papel || '') + '</small>' : '') + '</td><td>' + esc(l.fonte || '') + '<br><small>' + esc(l.operacao || '') + (l.escopo ? ' · ' + esc(l.escopo) : '') + '</small></td><td class="' + esc(l.decisao || '') + '">' + esc(l.decisao || '') + (l.status ? '<br><small>' + esc(String(l.status)) + '</small>' : '') + '</td><td>' + esc(l.motivo || '') + (l.itens != null ? '<br><small>' + esc(String(l.itens)) + ' item(ns), ' + esc(String(l.bytes || 0)) + ' bytes</small>' : '') + '</td></tr>').join('');
    return '<div class="ob-rolagem"><table class="ob-tabela"><thead><tr><th>Quando</th><th>Agente</th><th>Fonte</th><th>Decisão</th><th>Motivo</th></tr></thead><tbody>' + tr + '</tbody></table></div>';
  }

  /* Os valores do formulário viram a query da API (só o que foi preenchido). */
  function montaQuery(v) {
    const q = new URLSearchParams();
    for (const k of ['agente', 'pessoa', 'fonte', 'decisao', 'desde', 'ate']) { const x = String(v[k] || '').trim(); if (x) q.set(k, x); }
    q.set('limit', String(v.limit || 200));
    return q.toString();
  }

  const PASSOS = {
    resumo: {
      alvo: '#secResumo', titulo: 'Uso dos dados',
      oque: 'Quantos pedidos os agentes fizeram às fontes, bases e ferramentas, e quantos foram permitidos, negados ou viraram aprovação. "Sistemas de fora, por agente" diz qual agente usou qual sistema (CRM, ERP...) e com qual escopo.',
      como: 'Cada pedido à rota de dados vira uma linha de log, sem o conteúdo. Aqui elas são contadas por decisão, agente, fonte e pessoa.',
      porque: 'Para você ver, numa olhada, quem está usando o quê e se algum agente bate em porta fechada.',
    },
    linhas: {
      alvo: '#secLinhas', titulo: 'Quem leu o quê',
      oque: 'Linha a linha: quando, qual agente (e a pessoa dele), qual fonte e operação, a decisão e o motivo.',
      como: 'Filtre por agente, pessoa, fonte, decisão ou período. Baixar CSV leva as mesmas linhas, com os mesmos filtros, para a planilha.',
      porque: 'É a trilha que responde "quem acessou o dado X e quando", sem expor o dado.',
    },
  };

  if (!raiz.document) return { fmt, htmlBarras, htmlTiles, htmlLinhas, montaQuery, PASSOS, ROTULO };

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);

  async function chamar(caminho) {
    let r;
    try { r = await fetch(caminho, { credentials: 'same-origin', cache: 'no-store' }); } catch (e) {
      return { ok: false, erro: 'Não consegui falar com o servidor (' + e.message + ').' };
    }
    let json = null;
    try { json = await r.json(); } catch (e) { /* não é JSON */ }
    if (r.status === 401) return { ok: false, erro: 'Sua sessão acabou. Entre de novo em /login.' };
    if (!r.ok) return { ok: false, erro: (json && json.erro) || ('O servidor respondeu ' + r.status + '.') };
    return { ok: true, json: json || {} };
  }

  function msg(texto) { const e = $('msgGeral'); e.textContent = texto || ''; e.hidden = !texto; }

  function valores() {
    return { agente: $('fAgente').value, pessoa: $('fPessoa').value, fonte: $('fFonte').value, decisao: $('fDecisao').value, desde: $('fDesde').value, ate: $('fAte').value };
  }

  async function carregaResumo() {
    const r = await chamar('/api/v1/dados/log/resumo');
    if (!r.ok) { msg(r.erro); return; }
    $('tiles').innerHTML = htmlTiles(r.json);
    $('porAgente').innerHTML = htmlBarras(r.json.por_agente);
    $('porFonte').innerHTML = htmlBarras(r.json.por_fonte);
    $('porPessoa').innerHTML = htmlBarras(r.json.por_pessoa);
    $('porAgenteSistema').innerHTML = htmlBarras(r.json.por_agente_sistema);
  }

  async function carregaLinhas() {
    const q = montaQuery(valores());
    $('btnCsv').href = '/api/v1/dados/log.csv?' + q.replace(/limit=\d+/, 'limit=1000');
    const r = await chamar('/api/v1/dados/log?' + q);
    if (!r.ok) { msg(r.erro); return; }
    msg('');
    $('linhas').innerHTML = htmlLinhas(r.json.linhas);
  }

  function inicia() {
    $('filtros').addEventListener('submit', ev => { ev.preventDefault(); carregaLinhas(); });
    document.querySelectorAll('.lp-ajuda[data-ajuda]').forEach(b => b.addEventListener('click', () => { const p = PASSOS[b.dataset.ajuda]; if (raiz.DGTour && p) raiz.DGTour.inicia({ passos: [p] }); }));
    raiz.DGObservabilidadeTutorial = () => { if (raiz.DGTour) raiz.DGTour.inicia({ passos: Object.values(PASSOS) }); };
    Promise.all([carregaResumo(), carregaLinhas()]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicia);
  else inicia();

  return { fmt, htmlBarras, htmlTiles, htmlLinhas, montaQuery, PASSOS, ROTULO };
});
