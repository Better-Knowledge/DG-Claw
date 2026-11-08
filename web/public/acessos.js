'use strict';
/* acessos.js: a tela /acessos (só admin). Mostra, agente por agente, o que ele alcança (calculado pelo
   servidor com as mesmas funções da rota de dados) e edita o arquivo de papéis pelo Web: a pessoa e o papel
   de cada agente, os blocos de cada papel e de cada pessoa, e os grupos. Toda gravação passa pelo validador
   do servidor; aqui só montamos os formulários e os blocos. As funções sem DOM têm teste em
   web/test/acessos-tela.test.js. Contrato em web/docs/ACESSOS.md. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGAcessosTela = m;
})(this, function (raiz) {
  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const lista = (arr, vazio) => (arr && arr.length) ? '<ul>' + arr.map(x => '<li>' + x + '</li>').join('') + '</ul>' : '<span class="nada">' + esc(vazio || 'nada') + '</span>';

  /* O "efetivo" de um agente: o que ele alcança de fato, em quatro colunas. */
  function htmlEfetivo(ef) {
    const e = ef || {};
    return '<div class="ac-efetivo">' +
      '<div><h4>Fontes</h4>' + lista((e.fontes || []).map(f => esc(f.nome) + (f.campos ? ' <small>(' + esc(f.campos.join(', ')) + ')</small>' : '')), 'nenhuma') + '</div>' +
      '<div><h4>Bases</h4>' + lista((e.bases || []).map(b => esc(b.nome) + ' <small>(' + esc(b.escopo) + ')</small>'), 'nenhuma') + '</div>' +
      '<div><h4>Ferramentas</h4>' + lista((e.ferramentas || []).map(f => esc(f.nome) + ' <small>(' + esc(f.escopos.join(', ')) + ')</small>'), 'nenhuma') + '</div>' +
      '<div><h4>Skills compartilhadas</h4>' + lista((e.skills || []).map(esc), 'nenhuma') + '</div>' +
      '<div><h4>Ações (com aprovação)</h4>' + lista((e.acoes || []).map(esc), 'nenhuma') + '</div></div>';
  }

  const opcoes = (nomes, atual, vazio) => (vazio ? '<option value="">' + esc(vazio) + '</option>' : '') + nomes.map(n => '<option value="' + esc(n) + '"' + (n === atual ? ' selected' : '') + '>' + esc(n) + '</option>').join('');

  function htmlAgente(a, pessoas, papeis) {
    const semPolitica = !a.pessoa || !a.papel;
    return '<article class="ac-agente" data-slug="' + esc(a.slug) + '"><h3>' + esc(a.nome) + ' <small>(' + esc(a.slug) + ')</small></h3>' +
      (semPolitica ? '<p class="ac-sem">Este agente não está no arquivo de papéis: ele não alcança fonte, base, ferramenta nem skill compartilhada. Escolha a pessoa e o papel e salve.</p>' : '') +
      '<div class="ac-liga"><label>Pessoa <select name="pessoa">' + opcoes(pessoas, a.pessoa, 'escolha') + '</select></label>' +
      '<label>Papel <select name="papel">' + opcoes(papeis, a.papel, 'escolha') + '</select></label>' +
      '<button type="button" class="lp-btn pri" data-acao="ligar">Salvar</button>' +
      (semPolitica ? '' : '<button type="button" class="lp-btn" data-acao="tirar">Tirar do arquivo</button>') + '</div>' +
      htmlEfetivo(a.efetivo) +
      '<p class="ac-usuarios">Quem conversa com ele no painel: você' + ((a.colaboradores && a.colaboradores.length) ? ' e ' + a.colaboradores.map(c => esc(c.nome ? c.nome + ' (' + c.email + ')' : c.email)).join(', ') : ' (nenhum colaborador convidado)') + '</p></article>';
  }

  /* Caixa de marcar com um nome de campo e valor; `extra` vai depois do rótulo (ex.: operações). */
  const check = (nome, valor, marcado, rotulo, extra) => '<label class="lp-check"><input type="checkbox" name="' + esc(nome) + '" value="' + esc(valor) + '"' + (marcado ? ' checked' : '') + '> <span>' + esc(rotulo) + (extra ? ' <small>' + esc(extra) + '</small>' : '') + '</span></label>';

  /* O formulário de um papel (ou de uma pessoa, com `pessoa: true`): fontes, bases, ferramentas, skills e ações a partir dos catálogos. */
  function formBlocos(nome, bruto, cat, ehPessoa, grupos) {
    const b = bruto || {};
    const fontes = b.fontes || {}; const bases = b.bases || {}; const ferr = Array.isArray(b.ferramentas) ? b.ferramentas : []; const acoes = b.acoes || {};
    const skills = ehPessoa ? (b.skills || {}) : (Array.isArray(b.skills) ? b.skills : []);
    const nivelFonte = (f) => { const v = fontes[f]; if (!v) return ''; return typeof v === 'string' ? v : (v.nivel || ''); };
    const camposFonte = (f) => { const v = fontes[f]; return v && typeof v === 'object' && Array.isArray(v.campos) ? v.campos.join(', ') : ''; };
    let html = '';
    if (ehPessoa) {
      html += '<div class="ac-topo"><label>Nome completo <input name="nome" value="' + esc(b.nome || '') + '" placeholder="' + esc(nome) + '"></label>' +
        '<label>Estado <select name="estado"><option value="ativa"' + (b.estado !== 'desligada' ? ' selected' : '') + '>ativa</option><option value="desligada"' + (b.estado === 'desligada' ? ' selected' : '') + '>desligada (tudo negado)</option></select></label></div>' +
        '<fieldset><legend>Grupos</legend><div class="ac-grade">' + ((grupos || []).map(g => check('grupo', g, Array.isArray(b.grupos) && b.grupos.includes(g), g)).join('') || '<span class="lp-vazio">nenhum grupo criado</span>') + '</div></fieldset>';
    }
    html += '<fieldset><legend>Fontes' + (ehPessoa ? ' (o que a pessoa libera; o papel precisa liberar também)' : '') + '</legend><div class="ac-grade">' +
      cat.fontes.map(f => '<div>' + check('fonte', f.nome, nivelFonte(f.nome) === 'leitura', f.nome, 'operações: ' + f.operacoes.join(', ')) +
        (f.campos && f.campos.length ? '<input class="ac-campos" name="campos:' + esc(f.nome) + '" value="' + esc(camposFonte(f.nome)) + '" placeholder="campos (vazio = todos): ' + esc(f.campos.join(', ')) + '">' : '') + '</div>').join('') + '</div></fieldset>';
    const basesItens = (cat.bases && cat.bases.itens) || [];
    html += '<fieldset><legend>Bases de conhecimento</legend><div class="ac-grade">' +
      check('base', '*', bases['*'] === 'leitura', 'todas (*)', ehPessoa ? '' : 'as que o escopo da pessoa permitir') +
      basesItens.map(bs => check('base', bs.nome, bases[bs.nome] === 'leitura', bs.nome, bs.escopo + (bs.grupo ? ':' + bs.grupo : '') + (bs.pessoa ? ':' + bs.pessoa : ''))).join('') +
      '</div>' + (ehPessoa ? '<p class="lp-fraco">Para negar uma base específica a esta pessoa, marque abaixo.</p><div class="ac-grade">' + basesItens.map(bs => check('base_negada', bs.nome, bases[bs.nome] === 'negado', 'negar ' + bs.nome)).join('') + '</div>' : '') + '</fieldset>';
    const ferrItens = (cat.ferramentas && cat.ferramentas.itens) || [];
    html += '<fieldset><legend>Ferramentas e sistemas (escopos)</legend><div class="ac-grade">' +
      check('ferramenta', '*', ferr.includes('*'), 'todos os escopos (*)') +
      ferrItens.map(f => f.escopos.map(e => check('ferramenta', e.escopo, ferr.includes(e.escopo), e.escopo, f.titulo + ': ' + e.operacoes.join(', '))).join('')).join('') + '</div></fieldset>';
    const skillsItens = cat.skills || [];
    if (ehPessoa) {
      html += '<fieldset><legend>Skills compartilhadas negadas para esta pessoa</legend><div class="ac-grade">' +
        (skillsItens.filter(s => !s.escopo.startsWith('agente:')).map(s => check('skill_negada', s.nome, skills[s.nome] === 'negado', 'negar ' + s.nome, s.escopo)).join('') || '<span class="lp-vazio">nenhuma skill compartilhada publicada</span>') + '</div></fieldset>';
    } else {
      html += '<fieldset><legend>Skills compartilhadas</legend><div class="ac-grade">' +
        check('skill', '*', skills.includes('*'), 'todas (*)', 'as de grupo só para quem está no grupo') +
        skillsItens.filter(s => !s.escopo.startsWith('agente:')).map(s => check('skill', s.nome, skills.includes(s.nome), s.nome, s.escopo)).join('') + '</div></fieldset>';
    }
    const acoesConhecidas = {};
    for (const f of cat.fontes) for (const a of Object.values(f.acoes || {})) acoesConhecidas[a] = (acoesConhecidas[a] ? acoesConhecidas[a] + ', ' : '') + f.nome;
    for (const a of ['escrever_base', 'propor_skill']) if (!acoesConhecidas[a]) acoesConhecidas[a] = a === 'escrever_base' ? 'bases de conhecimento' : 'skills';
    for (const a of Object.keys(acoes)) if (!acoesConhecidas[a]) acoesConhecidas[a] = 'no arquivo';
    html += '<fieldset><legend>Ações (sempre com aprovação de uma pessoa no painel)</legend><div class="ac-grade">' +
      Object.keys(acoesConhecidas).sort().map(a => check('acao', a, acoes[a] === 'aprovacao_humana', a, acoesConhecidas[a])).join('') + '</div></fieldset>';
    html += '<div class="ac-rodape"><button type="submit" class="lp-btn pri">Salvar ' + (ehPessoa ? 'pessoa' : 'papel') + ' "' + esc(nome) + '"</button>' +
      (bruto ? '<button type="button" class="lp-btn perigo" data-acao="remover">Remover ' + (ehPessoa ? 'pessoa' : 'papel') + '</button>' : '') + '</div>';
    return html;
  }

  /* Dos campos marcados (lista de { name, value, checked }) para os blocos do arquivo. */
  function lerBlocos(campos, ehPessoa) {
    const c = (nome) => campos.filter(x => x.name === nome && x.checked).map(x => x.value);
    const texto = (nome) => { const x = campos.find(y => y.name === nome); return x ? String(x.value || '') : ''; };
    const fontes = {};
    for (const f of c('fonte')) {
      const campos = texto('campos:' + f).split(',').map(s => s.trim()).filter(Boolean);
      fontes[f] = campos.length ? { nivel: 'leitura', campos } : 'leitura';
    }
    const bases = {};
    for (const b of c('base')) bases[b] = 'leitura';
    if (ehPessoa) for (const b of c('base_negada')) bases[b] = 'negado';
    const ferramentas = c('ferramenta');
    const acoes = {};
    for (const a of c('acao')) acoes[a] = 'aprovacao_humana';
    const blocos = { fontes, bases, ferramentas, acoes };
    if (ehPessoa) {
      const skills = {}; for (const s of c('skill_negada')) skills[s] = 'negado';
      blocos.skills = skills;
      blocos.grupos = c('grupo');
      blocos.estado = texto('estado') || 'ativa';
      const nome = texto('nome').trim(); if (nome) blocos.nome = nome;
    } else {
      blocos.skills = c('skill');
    }
    return blocos;
  }

  function htmlGrupo(nome, g, pessoas) {
    const quem = Object.entries(pessoas || {}).filter(([, p]) => Array.isArray(p.grupos) && p.grupos.includes(nome)).map(([n]) => n);
    return '<div class="ac-grupo" data-grupo="' + esc(nome) + '"><b>' + esc(nome) + '</b> <span class="lp-chip">' + esc(g.tipo || 'equipe') + '</span><span class="ac-pessoas">' + (g.nome && g.nome !== nome ? esc(g.nome) + ' · ' : '') + (quem.length ? quem.join(', ') : 'sem pessoas') + '</span>' +
      (quem.length ? '' : '<button type="button" class="lp-btn" data-acao="remover-grupo">Remover</button>') + '</div>';
  }

  const PASSOS = {
    agentes: {
      alvo: '#secAgentes', titulo: 'O que cada agente alcança',
      oque: 'Para cada agente de trabalho: a pessoa que ele representa, o papel dele e o que isso dá de fato (fontes, bases, ferramentas, skills e ações).',
      como: 'Escolha a pessoa e o papel e salve. O "efetivo" é calculado pelas mesmas regras que a rota de dados usa: pessoa ∩ papel, com os escopos dos grupos.',
      porque: 'Você vê de uma vez o que um agente pode fazer, em vez de ler o arquivo de papéis à mão.',
    },
    papeis: {
      alvo: '#secPapeis', titulo: 'Papéis',
      oque: 'Um papel é um conjunto de permissões: quais fontes (e campos), bases, escopos de ferramentas, skills e ações.',
      como: 'Abra um papel ou crie um novo, marque o que ele libera e salve. Nada é gravado se o arquivo ficar inválido.',
      porque: 'Vários agentes compartilham um papel; mudar o papel muda todos na hora, sem mexer agente por agente.',
    },
    pessoas: {
      alvo: '#secPessoas', titulo: 'Pessoas',
      oque: 'A pessoa é o teto: o agente nunca alcança mais que ela. Os grupos dela dão as bases e skills de grupo; ela pode negar itens por nome.',
      como: 'Marque os grupos e o que a pessoa libera. "Desligada" nega tudo na hora (o comando dgclaw pessoa desligar faz isso e mais).',
      porque: 'Quem sai da empresa ou muda de time perde o acesso num lugar só, e nenhum agente herda o que não devia.',
    },
  };

  if (!raiz.document) return { htmlEfetivo, htmlAgente, formBlocos, lerBlocos, htmlGrupo, PASSOS };

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  let dados = null;

  async function chamar(metodo, caminho, corpo) {
    let r;
    try {
      r = await fetch(caminho, { method: metodo, credentials: 'same-origin', cache: 'no-store', headers: corpo !== undefined ? { 'Content-Type': 'application/json' } : {}, body: corpo !== undefined ? JSON.stringify(corpo) : undefined });
    } catch (e) { return { ok: false, erro: 'Não consegui falar com o servidor (' + e.message + ').' }; }
    let json = null;
    try { json = await r.json(); } catch (e) { /* não é JSON */ }
    if (r.status === 401) return { ok: false, erro: 'Sua sessão acabou. Entre de novo em /login.' };
    if (!r.ok) return { ok: false, erro: (json && json.erro) || ('O servidor respondeu ' + r.status + '.') };
    return { ok: true, json: json || {} };
  }
  const msg = (texto) => { const e = $('msgGeral'); e.textContent = texto || ''; e.hidden = !texto; if (texto) $('msgOk').hidden = true; };
  const ok = (texto) => { const e = $('msgOk'); e.textContent = texto || ''; e.hidden = !texto; if (texto) $('msgGeral').hidden = true; };

  const camposDe = (form) => Array.from(form.querySelectorAll('input,select')).map(el => ({ name: el.name, value: el.value, checked: el.type === 'checkbox' ? el.checked : true }));

  async function carrega(manter) {
    const r = await chamar('GET', '/api/v1/acessos');
    if (!r.ok) { msg(r.erro); return; }
    dados = r.json;
    const pessoas = Object.keys(dados.pessoas).sort(); const papeis = Object.keys(dados.papeis).sort();
    $('estadoPolitica').textContent = dados.politica_ok ? 'Arquivo de papéis: ' + dados.caminho + ' (válido).' : 'ATENÇÃO: o arquivo de papéis está inválido e toda a rota de dados está fechada: ' + (dados.erro || '');
    $('agentes').innerHTML = dados.agentes.map(a => htmlAgente(a, pessoas, papeis)).join('') || '<p class="lp-vazio">Nenhum agente de trabalho criado ainda.</p>';
    $('pSel').innerHTML = opcoes(papeis, manter && manter.papel, '(escolha)');
    $('psSel').innerHTML = opcoes(pessoas, manter && manter.pessoa, '(escolha)');
    $('grupos').innerHTML = Object.entries(dados.grupos).sort().map(([n, g]) => htmlGrupo(n, g, dados.pessoas)).join('') || '<p class="lp-vazio">Nenhum grupo ainda.</p>';
    if (manter && manter.papel) abrePapel(manter.papel); else $('formPapel').hidden = true;
    if (manter && manter.pessoa) abrePessoa(manter.pessoa); else $('formPessoa').hidden = true;
  }

  function abrePapel(nome) {
    const bruto = dados.bruto && dados.bruto.papeis[nome];
    $('formPapel').dataset.nome = nome;
    $('formPapel').innerHTML = formBlocos(nome, bruto, dados.catalogos, false);
    $('formPapel').hidden = false;
  }
  function abrePessoa(nome) {
    const bruto = dados.bruto && dados.bruto.pessoas[nome];
    $('formPessoa').dataset.nome = nome;
    $('formPessoa').innerHTML = formBlocos(nome, bruto, dados.catalogos, true, Object.keys(dados.grupos).sort());
    $('formPessoa').hidden = false;
  }
  const nomeEscolhido = (sel, inp) => ($(inp).value.trim().toLowerCase() || $(sel).value);

  async function salvar(tipo, nome, blocos, manter) {
    const r = await chamar('POST', '/api/v1/acessos/' + tipo + '/' + encodeURIComponent(nome), blocos);
    if (!r.ok) { msg(r.erro); return; }
    ok((tipo === 'papel' ? 'Papel' : tipo === 'pessoa' ? 'Pessoa' : 'Grupo') + ' "' + nome + '" gravado. Os agentes já estão com o acesso novo.');
    carrega(manter);
  }
  async function remover(tipo, nome) {
    if (!confirm('Remover ' + tipo + ' "' + nome + '" do arquivo de papéis?')) return;
    const r = await chamar('DELETE', '/api/v1/acessos/' + tipo + '/' + encodeURIComponent(nome));
    if (!r.ok) { msg(r.erro); return; }
    ok((tipo === 'papel' ? 'Papel' : tipo === 'pessoa' ? 'Pessoa' : 'Grupo') + ' "' + nome + '" removido.');
    carrega();
  }

  function inicia() {
    $('agentes').addEventListener('click', async ev => {
      const b = ev.target.closest('button[data-acao]'); if (!b) return;
      const card = b.closest('.ac-agente'); const slug = card.dataset.slug;
      if (b.dataset.acao === 'tirar') {
        if (!confirm('Tirar o agente ' + slug + ' do arquivo de papéis? Ele deixa de alcançar qualquer fonte, base, ferramenta ou skill compartilhada.')) return;
        const r = await chamar('POST', '/api/v1/acessos/agente/' + encodeURIComponent(slug), { remover: true });
        if (!r.ok) { msg(r.erro); return; }
        ok('Agente ' + slug + ' tirado do arquivo.'); carrega(); return;
      }
      const pessoa = card.querySelector('select[name="pessoa"]').value, papel = card.querySelector('select[name="papel"]').value;
      if (!pessoa || !papel) { msg('Escolha a pessoa e o papel do agente ' + slug + '.'); return; }
      const r = await chamar('POST', '/api/v1/acessos/agente/' + encodeURIComponent(slug), { pessoa, papel });
      if (!r.ok) { msg(r.erro); return; }
      ok('Agente ' + slug + ' ligado à pessoa ' + pessoa + ' com o papel ' + papel + '.'); carrega();
    });
    $('pAbrir').addEventListener('click', () => { const n = nomeEscolhido('pSel', 'pNovo'); if (!n) { msg('Escolha um papel ou digite o nome de um novo.'); return; } msg(''); abrePapel(n); });
    $('psAbrir').addEventListener('click', () => { const n = nomeEscolhido('psSel', 'psNovo'); if (!n) { msg('Escolha uma pessoa ou digite o nome de uma nova.'); return; } msg(''); abrePessoa(n); });
    $('formPapel').addEventListener('submit', ev => { ev.preventDefault(); const nome = ev.target.dataset.nome; salvar('papel', nome, lerBlocos(camposDe(ev.target), false), { papel: nome }); });
    $('formPessoa').addEventListener('submit', ev => { ev.preventDefault(); const nome = ev.target.dataset.nome; salvar('pessoa', nome, lerBlocos(camposDe(ev.target), true), { pessoa: nome }); });
    $('formPapel').addEventListener('click', ev => { const b = ev.target.closest('button[data-acao="remover"]'); if (b) remover('papel', $('formPapel').dataset.nome); });
    $('formPessoa').addEventListener('click', ev => { const b = ev.target.closest('button[data-acao="remover"]'); if (b) remover('pessoa', $('formPessoa').dataset.nome); });
    $('grupos').addEventListener('click', ev => { const b = ev.target.closest('button[data-acao="remover-grupo"]'); if (b) remover('grupo', b.closest('.ac-grupo').dataset.grupo); });
    $('formGrupo').addEventListener('submit', ev => {
      ev.preventDefault();
      const nome = $('gNome').value.trim().toLowerCase(); if (!nome) { msg('Digite o nome curto do grupo.'); return; }
      const corpo = { tipo: $('gTipo').value }; if ($('gTitulo').value.trim()) corpo.nome = $('gTitulo').value.trim();
      salvar('grupo', nome, corpo); $('formGrupo').reset();
    });
    document.querySelectorAll('.lp-ajuda[data-ajuda]').forEach(b => b.addEventListener('click', () => { const p = PASSOS[b.dataset.ajuda]; if (raiz.DGTour && p) raiz.DGTour.inicia({ passos: [p] }); }));
    raiz.DGAcessosTutorial = () => { if (raiz.DGTour) raiz.DGTour.inicia({ passos: Object.values(PASSOS) }); };
    carrega();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicia);
  else inicia();

  return { htmlEfetivo, htmlAgente, formBlocos, lerBlocos, htmlGrupo, PASSOS };
});
