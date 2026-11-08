'use strict';
/* dados.js: a tela /dados. Mostra as ações que esperam a aprovação do dono (com a ação exata e o hash),
   aprova ou recusa, mostra o estado do arquivo de papéis, o histórico de pedidos e as últimas linhas do
   log de acesso. Tudo pela API (web/docs/DADOS-POR-PAPEL.md). As funções que só montam texto ficam
   fora do DOM e têm teste em web/test/dados-tela.test.js. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGDadosTela = m;
})(this, function (raiz) {
  const ROTULO_ESTADO = {
    pendente: 'Aguardando', aprovada: 'Aprovada', executada: 'Executada', falhou: 'Falhou',
    recusada: 'Recusada', expirada: 'Expirada', revogada: 'Revogada',
  };
  const ROTULO_PARAM = { para: 'Para', assunto: 'Assunto', texto: 'Texto' };

  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* "2026-11-08T12:00:00.000Z" -> "08/11/2026 09:00" no fuso do navegador. */
  function fmt(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '-';
    const p = n => String(n).padStart(2, '0');
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* Quanto falta para o prazo: "faltam 12 min" ou "venceu". */
  function prazo(expiraEm, agoraMs) {
    const t = Date.parse(expiraEm);
    if (isNaN(t)) return '';
    const min = Math.ceil((t - (agoraMs || Date.now())) / 60000);
    if (min <= 0) return 'venceu';
    return 'faltam ' + min + ' min';
  }

  /* A lista de parâmetros como pares rótulo/valor, na ordem fixa; o que não tem rótulo vem com o nome cru. */
  function paresDe(params) {
    const p = params || {};
    const chaves = Object.keys(ROTULO_PARAM).filter(k => k in p).concat(Object.keys(p).filter(k => !(k in ROTULO_PARAM)).sort());
    return chaves.map(k => [ROTULO_PARAM[k] || k, typeof p[k] === 'string' ? p[k] : JSON.stringify(p[k])]);
  }

  function htmlPedido(p, agoraMs) {
    const pares = paresDe(p.params).map(([r, v]) => '<dt>' + esc(r) + '</dt><dd>' + esc(v) + '</dd>').join('');
    return '<article class="dp-pedido" data-id="' + esc(p.id) + '" data-hash="' + esc(p.hash) + '">' +
      '<h3>' + esc(p.descricao) + '</h3>' +
      '<p class="dp-meta">Pedido por ' + esc(p.pedido_por) + ' em ' + esc(fmt(p.pedido_em)) + ' · pessoa ' + esc(p.pessoa) + ', papel ' + esc(p.papel) + ' · ' + esc(prazo(p.expira_em, agoraMs)) + '</p>' +
      '<dl>' + pares + '</dl>' +
      '<p class="dp-hash">hash ' + esc(p.hash) + '</p>' +
      '<div class="dp-acoes"><button type="button" class="lp-btn dp-aprovar" data-acao="aprovar">Aprovar e executar</button>' +
      '<button type="button" class="lp-btn dp-recusar" data-acao="recusar">Recusar</button></div></article>';
  }

  function htmlHistorico(p) {
    const estado = p.estado || '';
    let fim = '';
    if (p.motivo) fim = ' · ' + esc(p.motivo);
    else if (p.resultado && p.resultado.simulado) fim = ' · registrado (envio simulado nesta versão)';
    return '<div class="dp-hist"><span class="dp-estado ' + esc(estado) + '">' + esc(ROTULO_ESTADO[estado] || estado) + '</span>' +
      esc(p.descricao) + ' <small>' + esc(fmt(p.decidido_em || p.pedido_em)) + (p.decidido_por ? ' por ' + esc(p.decidido_por) : '') + '</small>' + fim + '</div>';
  }

  function htmlLog(l) {
    const alvo = (l.fonte || '?') + '/' + (l.operacao || '?');
    return '<div class="dp-log"><span class="' + esc(l.decisao || '') + '">' + esc(l.decisao || '?') + '</span> ' + esc(fmt(l.quando)) + ' · ' + esc(l.agente || '?') +
      (l.pessoa ? ' (' + esc(l.pessoa) + '/' + esc(l.papel || '?') + ')' : '') + ' · ' + esc(alvo) +
      (l.itens != null ? ' · ' + esc(String(l.itens)) + ' item(ns)' : '') + (l.motivo && l.decisao !== 'permitido' ? ' · ' + esc(l.motivo) : '') + '</div>';
  }

  function htmlPapeis(r) {
    if (!r.valido) return '<p class="dp-erro">' + esc(r.erro || 'inválido') + '</p>';
    if (r.origem === 'ausente') return '<p class="dp-papel">O arquivo <code>/etc/dgclaw/papeis.json</code> ainda não existe: nenhum agente alcança fonte alguma. Peça ao Admin para criá-lo (veja a documentação em <code>web/docs/DADOS-POR-PAPEL.md</code>).</p>';
    const ag = r.agentes || [];
    const linhas = ag.map(s => { const a = r.politica.agentes[s]; return '<p class="dp-papel"><code>' + esc(s) + '</code> trabalha para <code>' + esc(a.pessoa) + '</code> com o papel <code>' + esc(a.papel) + '</code></p>'; }).join('');
    return '<p class="dp-papel">' + esc(String(r.pessoas)) + ' pessoa(s), ' + esc(String(r.papeis)) + ' papel(is), ' + esc(String(ag.length)) + ' agente(s) ligado(s). Hash ' + esc(r.hash || '-') + '.</p>' +
      (ag.length ? linhas : '<p class="dp-papel">Nenhum agente ligado ainda: acrescente-o em "agentes" no arquivo.</p>');
  }

  const ROTULO_ESCOPO = { privada: 'privada', grupo: 'do grupo', empresa: 'da empresa', publica: 'pública' };

  function htmlBases(r) {
    if (!r.valido) return '<p class="dp-erro">' + esc(r.erro || 'inválido') + '</p>';
    const nomes = Object.keys(r.bases || {}).sort();
    if (!nomes.length) return '<p class="dp-papel">Nenhuma base cadastrada. No servidor: <code>sudo dgclaw base criar manual-rh --escopo empresa</code>.</p>';
    return nomes.map(n => {
      const b = r.bases[n];
      const quem = b.escopo === 'grupo' ? ' ' + esc(b.grupo) : b.escopo === 'privada' ? ' de ' + esc(b.pessoa) : '';
      return '<p class="dp-papel"><code>' + esc(n) + '</code> ' + esc(b.nome && b.nome !== n ? b.nome : '') + ' · ' + esc(ROTULO_ESCOPO[b.escopo] || b.escopo) + quem + ' · ' + esc(b.classificacao) + (b.dono && b.dono !== 'nao-informado' ? ' · dono ' + esc(b.dono) : '') + '</p>';
    }).join('');
  }

  function htmlFerramentas(r) {
    if (!r.valido) return '<p class="dp-erro">' + esc(r.erro || 'inválido') + '</p>';
    const nomes = Object.keys(r.ferramentas || {}).sort();
    const cred = (r.credenciais || []).length ? '<p class="dp-papel">Credenciais no cofre de sistemas (só os nomes): ' + (r.credenciais || []).map(c => '<code>' + esc(c) + '</code>').join(' ') + '</p>' : '<p class="dp-papel">Nenhuma credencial no cofre de sistemas.</p>';
    if (!nomes.length) return cred + '<p class="dp-papel">Nenhuma ferramenta no catálogo. No servidor, descreva o sistema em <code>/etc/dgclaw/ferramentas.json</code> (veja <code>web/docs/FERRAMENTAS-POR-ESCOPO.md</code>).</p>';
    return cred + nomes.map(n => {
      const f = r.ferramentas[n];
      const ops = Object.entries(f.operacoes || {}).map(([o, d]) => esc(o) + (d.acao ? ' (ação)' : '') + ' <small>' + esc(d.escopo) + '</small>').join(', ');
      const semCred = f.credencial && !(r.credenciais || []).includes(f.credencial) ? ' <span class="dp-erro">· credencial ' + esc(f.credencial) + ' não está no cofre</span>' : '';
      return '<p class="dp-papel"><code>' + esc(n) + '</code> ' + esc(f.titulo && f.titulo !== n ? f.titulo : '') + ' · ' + esc(f.tipo) + (f.credencial ? ' · credencial ' + esc(f.credencial) : '') + semCred + '<br>' + (ops || 'sem operações') + '</p>';
    }).join('');
  }

  const PASSOS = {
    pendentes: {
      alvo: '#secPendentes', titulo: 'Ações aguardando sua aprovação',
      oque: 'Cada cartão é uma ação que um agente pediu para fazer fora da conversa (enviar um e-mail, por exemplo), com os dados exatos.',
      como: 'O agente pede, o servidor guarda os dados da ação e manda um aviso. Aprovar executa exatamente o que está escrito no cartão; o agente não consegue mudar nada depois de pedir, e cada aprovação vale uma vez. O pedido vence em 15 minutos.',
      porque: 'O agente não executa ação nenhuma sozinho: você lê e decide. É o software que impede, não o prompt.',
    },
    papeis: {
      alvo: '#secPapeis', titulo: 'Papéis de acesso a dados',
      oque: 'Quem trabalha para quem e com qual papel, lido do arquivo /etc/dgclaw/papeis.json.',
      como: 'O arquivo fica fora do alcance dos agentes. O que não está escrito é negado; um agente só alcança uma fonte se a pessoa dele E o papel dele liberam. Para mudar, edite o arquivo ou peça ao Admin.',
      porque: 'Para você conferir, numa olhada, o que cada agente alcança e se o arquivo está válido.',
    },
    bases: {
      alvo: '#secBases', titulo: 'Bases de conhecimento',
      oque: 'As pastas de texto que os agentes consultam, com o escopo de cada uma: privada, do grupo, da empresa ou pública.',
      como: 'Você cadastra no servidor com "dgclaw base criar" e põe os arquivos em /var/lib/dgclaw/bases/<nome>. Cada papel diz quais bases lê; a pessoa só alcança o que o escopo dela permite. Escrever numa base passa pela sua aprovação, aqui em cima.',
      porque: 'Para você ver de relance o que existe e quem alcança, sem abrir arquivo nenhum.',
    },
    ferramentas: {
      alvo: '#secFerramentas', titulo: 'Ferramentas e sistemas',
      oque: 'Os sistemas de fora (CRM, ERP, servidor MCP, banco) que os agentes usam pelo gateway, com as operações e o escopo de cada uma.',
      como: 'A credencial de cada sistema fica só no servidor; o agente pede a operação e o DG Claw chama o sistema por ele. Cada operação tem um escopo (crm:ler, crm:escrever) que precisa estar na pessoa e no papel do agente. Operação que escreve passa pela sua aprovação, aqui em cima.',
      porque: 'Para você ver de relance o que está cadastrado e se alguma credencial está faltando, sem abrir arquivo nenhum.',
    },
    log: {
      alvo: '#secLog', titulo: 'Últimos acessos',
      oque: 'Quem leu o quê, quando e com qual decisão. Sem o conteúdo dos dados.',
      como: 'Cada pedido à rota de dados vira uma linha, permitido ou negado, com o motivo.',
      porque: 'Para você ver se um agente está tentando alcançar o que não deve.',
    },
  };

  if (!raiz.document) return { fmt, prazo, paresDe, htmlPedido, htmlHistorico, htmlLog, htmlPapeis, htmlBases, htmlFerramentas, ROTULO_ESTADO, PASSOS };

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  const POLL_MS = 15000;

  async function chamar(metodo, caminho, corpo) {
    let r;
    try {
      r = await fetch(caminho, {
        method: metodo, credentials: 'same-origin', cache: 'no-store',
        headers: corpo === undefined ? {} : { 'Content-Type': 'application/json' },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
      });
    } catch (e) {
      return { ok: false, erro: 'Não consegui falar com o servidor (' + e.message + '). Confira a conexão e tente de novo.' };
    }
    let json = null;
    try { json = await r.json(); } catch (e) { console.warn('dados: a resposta de ' + caminho + ' não veio em JSON:', e.message); }
    if (r.status === 401) return { ok: false, erro: 'Sua sessão acabou. Entre de novo em /login.' };
    if (!r.ok) return { ok: false, erro: (json && json.erro) || ('O servidor respondeu ' + r.status + ' em ' + caminho + '.') };
    return { ok: true, json: json || {} };
  }

  function msg(texto, tipo) {
    const e = $('msgGeral');
    e.textContent = texto || '';
    e.className = 'lp-msg' + (tipo ? ' ' + tipo : '');
    e.hidden = !texto;
  }

  async function carregaPendentes() {
    /* Pendentes vêm todos (até o teto do servidor), numa chamada só deles: um histórico cheio nunca esconde um cartão. */
    const r = await chamar('GET', '/api/v1/dados/aprovacoes?estado=pendente&limit=500');
    if (!r.ok) { msg(r.erro, 'erro'); return; }
    const pend = r.json.aprovacoes || [];
    $('pendentes').innerHTML = pend.length ? pend.map(p => htmlPedido(p)).join('') : '<p class="lp-vazio">Nenhuma ação esperando você.</p>';
    document.title = (pend.length ? '(' + pend.length + ') ' : '') + 'Dados - DG Claw';
    const h = await chamar('GET', '/api/v1/dados/aprovacoes?limit=40');
    if (!h.ok) return;
    const hist = (h.json.aprovacoes || []).filter(p => p.estado !== 'pendente').slice(0, 30);
    $('historico').innerHTML = hist.length ? hist.map(htmlHistorico).join('') : '<p class="lp-vazio">Nenhum ainda.</p>';
  }

  async function carregaPapeis() {
    const r = await chamar('GET', '/api/v1/dados/papeis');
    if (!r.ok) { $('papeisEstado').textContent = r.erro; return; }
    $('papeisEstado').textContent = r.json.valido ? 'Arquivo válido.' : 'Arquivo inválido: todo acesso está negado até corrigir.';
    $('papeis').innerHTML = htmlPapeis(r.json);
  }

  async function carregaBases() {
    const r = await chamar('GET', '/api/v1/dados/bases');
    if (!r.ok) { $('basesEstado').textContent = r.erro; return; }
    $('basesEstado').textContent = r.json.valido ? (Object.keys(r.json.bases || {}).length + ' base(s) no catálogo.') : 'Catálogo inválido: nenhuma base é alcançada até corrigir.';
    $('bases').innerHTML = htmlBases(r.json);
  }

  async function carregaFerramentas() {
    const r = await chamar('GET', '/api/v1/dados/ferramentas');
    if (!r.ok) { $('ferramentasEstado').textContent = r.erro; return; }
    $('ferramentasEstado').textContent = r.json.valido ? (Object.keys(r.json.ferramentas || {}).length + ' ferramenta(s) no catálogo.') : 'Catálogo inválido: nenhuma ferramenta funciona até corrigir.';
    $('ferramentas').innerHTML = htmlFerramentas(r.json);
  }

  async function carregaLog() {
    const r = await chamar('GET', '/api/v1/dados/log?limit=50');
    if (!r.ok) return;
    const linhas = r.json.linhas || [];
    $('log').innerHTML = linhas.length ? linhas.map(htmlLog).join('') : '<p class="lp-vazio">Nenhum acesso registrado.</p>';
  }

  async function decide(art, acao) {
    const id = art.dataset.id;
    const botoes = art.querySelectorAll('button');
    botoes.forEach(b => { b.disabled = true; });
    let corpo = {};
    if (acao === 'aprovar') corpo = { hash: art.dataset.hash };
    else { const m = prompt('Motivo da recusa (opcional):'); if (m === null) { botoes.forEach(b => { b.disabled = false; }); return; } corpo = m ? { motivo: m } : {}; }
    const r = await chamar('POST', '/api/v1/dados/aprovacoes/' + encodeURIComponent(id) + '/' + acao, corpo);
    if (!r.ok) { msg(r.erro, 'erro'); botoes.forEach(b => { b.disabled = false; }); }
    else msg(acao === 'aprovar' ? 'Aprovado: ' + (r.json.pedido.estado === 'executada' ? 'a ação foi executada.' : 'a ação ' + (ROTULO_ESTADO[r.json.pedido.estado] || r.json.pedido.estado).toLowerCase() + (r.json.pedido.motivo ? ' (' + r.json.pedido.motivo + ')' : '') + '.') : 'Recusado.', 'ok');
    await Promise.all([carregaPendentes(), carregaLog()]);
  }

  function inicia() {
    $('pendentes').addEventListener('click', ev => {
      const b = ev.target.closest('button[data-acao]');
      if (!b) return;
      decide(b.closest('.dp-pedido'), b.dataset.acao);
    });
    document.querySelectorAll('.lp-ajuda[data-ajuda]').forEach(b => b.addEventListener('click', () => {
      const p = PASSOS[b.dataset.ajuda];
      if (raiz.DGTour && p) raiz.DGTour.inicia({ passos: [p] });
    }));
    raiz.DGDadosTutorial = () => { if (raiz.DGTour) raiz.DGTour.inicia({ passos: Object.values(PASSOS) }); };
    Promise.all([carregaPendentes(), carregaPapeis(), carregaBases(), carregaFerramentas(), carregaLog()]);
    setInterval(() => { if (!document.hidden) carregaPendentes(); }, POLL_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicia);
  else inicia();

  return { fmt, prazo, paresDe, htmlPedido, htmlHistorico, htmlLog, htmlPapeis, htmlBases, htmlFerramentas, ROTULO_ESTADO, PASSOS };
});
