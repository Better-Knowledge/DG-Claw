'use strict';
// Painel de acessos (web/docs/ACESSOS.md): o admin vê, agente por agente, o que ele alcança (fontes, bases,
// ferramentas, skills, ações) e edita o /etc/dgclaw/papeis.json pelo Web: a pessoa e o papel de cada agente,
// os blocos de cada papel e de cada pessoa, e os grupos. Toda gravação passa pelo mesmo validaPapeis do Web
// (web/lib/papeis-editor.js); o "efetivo" é calculado pelas mesmas funções que decidem na rota de dados.
//
//   GET    /api/v1/acessos                      a visão inteira (agentes com colaboradores, pessoas, papéis, grupos, catálogos, efetivo)
//   POST   /api/v1/acessos/agente/<slug>        { pessoa, papel } liga o agente a uma pessoa e um papel; { remover: true } tira do arquivo
//   POST   /api/v1/acessos/papel/<nome>         { fontes?, bases?, ferramentas?, skills?, acoes? } cria ou troca os blocos dados
//   DELETE /api/v1/acessos/papel/<nome>         remove o papel (só sem agente apontando para ele)
//   POST   /api/v1/acessos/pessoa/<nome>        { nome?, grupos?, estado?, fontes?, bases?, ferramentas?, skills?, acoes? }
//   DELETE /api/v1/acessos/pessoa/<nome>        remove a pessoa (só sem agente apontando para ela)
//   POST   /api/v1/acessos/grupo/<nome>         { nome?, tipo? }
//   DELETE /api/v1/acessos/grupo/<nome>         remove o grupo (só sem pessoa nele)
//   GET    /acessos                             a tela
// Só o admin. A caixa dos agentes nunca chega aqui.

const fs = require('node:fs');
const path = require('node:path');
const H = require('./http');
const { criarPapeisEditor, ErroEdicao } = require('./papeis-editor');
const { decidir, decidirBase, decidirFerramenta } = require('./dados-decisao');

const RX_NOME = /^[a-z][a-z0-9_-]{0,39}$/;
const RX_SLUG = /^[a-z0-9][a-z0-9-]{1,30}$/;
const RX_SKILL = /^[a-z][a-z0-9-]{0,39}$/;
const BLOCOS = ['fontes', 'bases', 'ferramentas', 'skills', 'acoes'];
const MAX_CORPO = 64 * 1024;

const ehObjeto = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const tem = (o, k) => ehObjeto(o) && Object.prototype.hasOwnProperty.call(o, k);

function criarAcessos({ papeis, bases, ferramentas, skillsDir, registro, colaboradores, fontes, config, log, servirArquivo }) {
  const editor = criarPapeisEditor({ caminho: config.papeisPath, log });

  // ── catálogos ─────────────────────────────────────────────────────────────
  function catalogoFontes() {
    const saida = [];
    try {
      for (const f of fontes.catalogo()) {
        if (f.base || f.ferramenta) continue;
        saida.push({ nome: f.nome, campos: f.campos || [], operacoes: f.operacoes, acoes: f.acoes || {} });
      }
    } catch (e) { log('aviso', `Acessos: não consegui listar as fontes (${e.message}).`); }
    return saida;
  }
  function catalogoBases() {
    const e = bases ? bases.estado() : null;
    if (!e || !e.ok) return { ok: false, erro: e ? e.erro : null, itens: [] };
    return { ok: true, erro: null, itens: Object.entries(e.bases).map(([n, b]) => ({ nome: n, titulo: b.nome, escopo: b.escopo, grupo: b.grupo || null, pessoa: b.pessoa || null })) };
  }
  function catalogoFerramentas() {
    const e = ferramentas ? ferramentas.estado() : null;
    if (!e || !e.ok) return { ok: false, erro: e ? e.erro : null, itens: [] };
    const itens = Object.entries(e.ferramentas).map(([n, f]) => {
      const escopos = {};
      for (const [op, o] of Object.entries(f.operacoes || {})) { (escopos[o.escopo] = escopos[o.escopo] || []).push(op + (o.acao ? ' (ação)' : '')); }
      return { nome: n, titulo: f.titulo, tipo: f.tipo, escopos: Object.entries(escopos).map(([esc, ops]) => ({ escopo: esc, operacoes: ops })) };
    });
    return { ok: true, erro: null, itens };
  }
  function catalogoSkills() {
    const itens = [];
    const le = (pasta, escopo) => {
      let nomes = [];
      try { nomes = fs.readdirSync(pasta, { withFileTypes: true }); } catch (_) { return; }
      for (const d of nomes) {
        if (!d.isDirectory() || !RX_SKILL.test(d.name)) continue;
        try { if (fs.statSync(path.join(pasta, d.name, 'SKILL.md')).isFile()) itens.push({ nome: d.name, escopo }); } catch (_) { /* sem SKILL.md */ }
      }
    };
    if (!skillsDir) return itens;
    le(path.join(skillsDir, 'globais'), 'global');
    for (const base of ['grupos', 'agentes']) {
      let subs = [];
      try { subs = fs.readdirSync(path.join(skillsDir, base), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (_) { subs = []; }
      for (const s of subs.sort()) le(path.join(skillsDir, base, s), `${base === 'grupos' ? 'grupo' : 'agente'}:${s}`);
    }
    return itens;
  }

  // ── efetivo: o que o agente alcança, pelas mesmas funções da rota ───────────
  function skillsEfetivas(pol, slug, ag, lista) {
    const pessoa = pol.pessoas[ag.pessoa]; const papel = pol.papeis[ag.papel];
    const saida = [];
    for (const s of lista) {
      if (s.escopo === `agente:${slug}`) { saida.push(s.nome); continue; }
      if (s.escopo.startsWith('agente:')) continue;
      if (!pessoa || !papel || pessoa.estado === 'desligada') continue;
      if (tem(pessoa.skills, s.nome) && pessoa.skills[s.nome] === 'negado') continue;
      if (!(papel.skills.includes('*') || papel.skills.includes(s.nome))) continue;
      if (s.escopo.startsWith('grupo:') && !pessoa.grupos.includes(s.escopo.slice(6))) continue;
      saida.push(s.nome);
    }
    return [...new Set(saida)];
  }
  function efetivo(estado, slug, catalogos) {
    const ag = estado.ok ? estado.politica.agentes[slug] : null;
    const saida = { fontes: [], bases: [], ferramentas: [], skills: [], acoes: [] };
    if (!ag) return saida;
    for (const f of catalogos.fontes) {
      const d = decidir({ estado, slug, fonte: f.nome, operacao: f.operacoes[0] || 'listar', acao: null });
      if (d.decisao === 'permitido') saida.fontes.push({ nome: f.nome, campos: d.campos });
      for (const [op, acao] of Object.entries(f.acoes || {})) {
        const da = decidir({ estado, slug, fonte: f.nome, operacao: op, acao });
        if (da.decisao === 'aprovacao') saida.acoes.push(`${acao} (${f.nome})`);
      }
    }
    const eb = bases ? bases.estado() : null;
    if (eb && eb.ok) for (const [n, b] of Object.entries(eb.bases)) {
      const d = decidirBase({ estado, slug, base: b, nomeBase: n, operacao: 'listar', acao: null });
      if (d.decisao === 'permitido') saida.bases.push({ nome: n, escopo: b.escopo });
    }
    const ef = ferramentas ? ferramentas.estado() : null;
    if (ef && ef.ok) for (const [n, f] of Object.entries(ef.ferramentas)) {
      const escopos = new Set();
      for (const op of Object.keys(f.operacoes || {})) {
        const d = decidirFerramenta({ estado, slug, ferramenta: f, nomeFerramenta: n, operacao: op });
        if (d.decisao === 'permitido' || d.decisao === 'aprovacao') escopos.add(f.operacoes[op].escopo);
      }
      if (escopos.size) saida.ferramentas.push({ nome: n, escopos: [...escopos] });
    }
    saida.skills = skillsEfetivas(estado.politica, slug, ag, catalogos.skills);
    return saida;
  }

  function visao() {
    const estado = papeis.estado();
    const catalogos = { fontes: catalogoFontes(), bases: catalogoBases(), ferramentas: catalogoFerramentas(), skills: catalogoSkills() };
    const er = registro.estado();
    const agentes = (er.ok ? er.agentes : []).filter((a) => a.tipo !== 'admin').map((a) => {
      const ag = estado.ok ? estado.politica.agentes[a.slug] : null;
      return {
        slug: a.slug, nome: a.nome,
        pessoa: ag ? ag.pessoa : null, papel: ag ? ag.papel : null,
        colaboradores: (() => { try { return colaboradores.ativosDoAgente(a.slug).map((c) => ({ email: c.email, nome: c.nome || '' })); } catch (e) { return []; } })(),
        efetivo: efetivo(estado, a.slug, { fontes: catalogos.fontes, skills: catalogos.skills }),
      };
    });
    const bruto = (() => { try { return editor.lerBruto(); } catch (e) { return null; } })();
    return {
      ok: true,
      politica_ok: estado.ok, erro: estado.ok ? null : estado.erro, caminho: config.papeisPath,
      agentes,
      pessoas: estado.ok ? estado.politica.pessoas : {},
      papeis: estado.ok ? estado.politica.papeis : {},
      grupos: estado.ok ? estado.politica.grupos : {},
      // O bruto dos blocos (como está no arquivo) para o formulário editar sem perder "comentario" e afins.
      bruto: bruto ? { pessoas: bruto.pessoas || {}, papeis: bruto.papeis || {}, grupos: bruto.grupos || {} } : null,
      catalogos,
    };
  }

  // ── edição ────────────────────────────────────────────────────────────────
  function aplicaBlocos(destino, corpo, permitidos) {
    for (const k of permitidos) {
      if (corpo[k] === undefined) continue;
      if (corpo[k] === null) { delete destino[k]; continue; }
      destino[k] = corpo[k];
    }
  }
  const nomeOuErro = (res, nome, oque) => { if (!RX_NOME.test(nome)) { H.erroJson(res, 400, `O nome de ${oque} "${String(nome).slice(0, 40)}" não vale: minúsculas, números, _ e -, começando por letra, até 40.`); return false; } return true; };

  async function editarAgente(req, res, slug) {
    if (!RX_SLUG.test(slug)) return H.erroJson(res, 400, 'Slug de agente inválido.');
    const ag = registro.obter(slug);
    if (!ag) return H.erroJson(res, 404, `Não existe o agente "${slug}".`);
    if (ag.tipo === 'admin') return H.erroJson(res, 400, 'O Admin do servidor não entra nos papéis de dados.');
    const corpo = await H.lerJson(req, MAX_CORPO);
    const c = ehObjeto(corpo) ? corpo : {};
    const r = editor.editar((bruto) => {
      if (c.remover === true) { delete bruto.agentes[slug]; return; }
      if (typeof c.pessoa !== 'string' || typeof c.papel !== 'string') throw new ErroEdicao('Mande { "pessoa": "...", "papel": "..." } ou { "remover": true }.', 400);
      bruto.agentes[slug] = Object.assign(ehObjeto(bruto.agentes[slug]) ? bruto.agentes[slug] : {}, { pessoa: c.pessoa, papel: c.papel });
    });
    log('info', `Acessos: agente ${slug} ${c.remover ? 'tirado do arquivo de papéis' : `ligado à pessoa ${c.pessoa} com o papel ${c.papel}`}.`);
    return H.enviaJson(res, 200, { ok: true, agente: r.politica.agentes[slug] || null });
  }

  async function editarPapel(req, res, nome, metodo) {
    if (!nomeOuErro(res, nome, 'papel')) return undefined;
    if (metodo === 'DELETE') {
      editor.editar((bruto) => {
        if (!tem(bruto.papeis, nome)) throw new ErroEdicao(`Não existe o papel "${nome}".`, 404);
        const usa = Object.entries(bruto.agentes || {}).filter(([, a]) => ehObjeto(a) && a.papel === nome).map(([s]) => s);
        if (usa.length) throw new ErroEdicao(`O papel "${nome}" ainda é usado pelos agentes ${usa.join(', ')}. Troque o papel deles antes.`, 409);
        delete bruto.papeis[nome];
      });
      log('info', `Acessos: papel ${nome} removido.`);
      return H.enviaJson(res, 200, { ok: true, removido: nome });
    }
    const corpo = await H.lerJson(req, MAX_CORPO);
    const c = ehObjeto(corpo) ? corpo : {};
    const r = editor.editar((bruto) => {
      if (!tem(bruto.papeis, nome)) bruto.papeis[nome] = {};
      if (!ehObjeto(bruto.papeis[nome])) throw new ErroEdicao(`O papel "${nome}" não é um objeto no arquivo; corrija no servidor.`, 409);
      aplicaBlocos(bruto.papeis[nome], c, BLOCOS);
    });
    log('info', `Acessos: papel ${nome} gravado (${Object.keys(c).filter((k) => BLOCOS.includes(k)).join(', ') || 'sem blocos'}).`);
    return H.enviaJson(res, 200, { ok: true, papel: r.politica.papeis[nome] });
  }

  async function editarPessoa(req, res, nome, metodo) {
    if (!nomeOuErro(res, nome, 'pessoa')) return undefined;
    if (metodo === 'DELETE') {
      editor.editar((bruto) => {
        if (!tem(bruto.pessoas, nome)) throw new ErroEdicao(`Não existe a pessoa "${nome}".`, 404);
        const usa = Object.entries(bruto.agentes || {}).filter(([, a]) => ehObjeto(a) && a.pessoa === nome).map(([s]) => s);
        if (usa.length) throw new ErroEdicao(`A pessoa "${nome}" ainda tem os agentes ${usa.join(', ')}. Troque a pessoa deles antes (ou use dgclaw pessoa desligar).`, 409);
        delete bruto.pessoas[nome];
      });
      log('info', `Acessos: pessoa ${nome} removida.`);
      return H.enviaJson(res, 200, { ok: true, removido: nome });
    }
    const corpo = await H.lerJson(req, MAX_CORPO);
    const c = ehObjeto(corpo) ? corpo : {};
    const r = editor.editar((bruto) => {
      if (!tem(bruto.pessoas, nome)) bruto.pessoas[nome] = {};
      if (!ehObjeto(bruto.pessoas[nome])) throw new ErroEdicao(`A pessoa "${nome}" não é um objeto no arquivo; corrija no servidor.`, 409);
      aplicaBlocos(bruto.pessoas[nome], c, BLOCOS.concat(['nome', 'grupos', 'estado']));
    });
    log('info', `Acessos: pessoa ${nome} gravada (${Object.keys(c).join(', ') || 'sem campos'}).`);
    return H.enviaJson(res, 200, { ok: true, pessoa: r.politica.pessoas[nome] });
  }

  async function editarGrupo(req, res, nome, metodo) {
    if (!nomeOuErro(res, nome, 'grupo')) return undefined;
    if (metodo === 'DELETE') {
      editor.editar((bruto) => {
        if (!tem(bruto.grupos, nome)) throw new ErroEdicao(`Não existe o grupo "${nome}".`, 404);
        const usa = Object.entries(bruto.pessoas || {}).filter(([, p]) => ehObjeto(p) && Array.isArray(p.grupos) && p.grupos.includes(nome)).map(([n]) => n);
        if (usa.length) throw new ErroEdicao(`O grupo "${nome}" ainda tem as pessoas ${usa.join(', ')}. Tire-as do grupo antes.`, 409);
        delete bruto.grupos[nome];
      });
      log('info', `Acessos: grupo ${nome} removido.`);
      return H.enviaJson(res, 200, { ok: true, removido: nome });
    }
    const corpo = await H.lerJson(req, MAX_CORPO);
    const c = ehObjeto(corpo) ? corpo : {};
    const r = editor.editar((bruto) => {
      if (!ehObjeto(bruto.grupos)) bruto.grupos = {};
      if (!tem(bruto.grupos, nome)) bruto.grupos[nome] = {};
      if (!ehObjeto(bruto.grupos[nome])) throw new ErroEdicao(`O grupo "${nome}" não é um objeto no arquivo; corrija no servidor.`, 409);
      aplicaBlocos(bruto.grupos[nome], c, ['nome', 'tipo']);
    });
    log('info', `Acessos: grupo ${nome} gravado.`);
    return H.enviaJson(res, 200, { ok: true, grupo: r.politica.grupos[nome] });
  }

  function responderErro(res, e) {
    if (e instanceof ErroEdicao) return H.erroJson(res, e.status, e.message, e.erros ? { erros: e.erros } : undefined);
    if (e && e.status) return H.erroJson(res, e.status, e.message);
    log('erro', `Acessos: ${e && e.stack ? e.stack : e}`);
    return H.erroJson(res, 500, 'Não consegui concluir. O detalhe está no log do Web.');
  }

  async function rotas(req, res, url, sessao) {
    const p = url.pathname;
    const m = req.method;
    const ehApi = p === '/api/v1/acessos' || p.startsWith('/api/v1/acessos/');
    const ehPagina = p === '/acessos' || p === '/acessos/';
    if (!ehApi && !ehPagina) return false;
    // Só o dono (o colaborador já é barrado antes pelo escopo.js; aqui é a segunda trava).
    const dono = !!sessao && sessao.via !== 'caixa' && sessao.papel !== 'colaborador';
    if (!dono) {
      if (ehPagina) H.paginaErro(res, 403, 'Só o dono', 'O controle de acesso dos agentes é do dono do DG Claw.');
      else H.erroJson(res, 403, 'Só o dono do DG Claw mexe no controle de acesso dos agentes.');
      return true;
    }
    try {
      if (ehPagina) {
        if (m !== 'GET' && m !== 'HEAD') { H.erroJson(res, 405, 'Use GET.'); return true; }
        if (!servirArquivo(req, res, path.join(config.publicDir, 'acessos.html'), 'no-store')) H.paginaErro(res, 500, 'Tela não instalada', 'O arquivo da tela de acessos não foi encontrado no servidor. Reinstale o DG Claw Web.');
        return true;
      }
      if (p === '/api/v1/acessos') {
        if (m !== 'GET') { H.erroJson(res, 405, 'Use GET para ver os acessos; as mudanças vão em /api/v1/acessos/agente|papel|pessoa|grupo/<nome>.'); return true; }
        H.enviaJson(res, 200, visao());
        return true;
      }
      const mm = /^\/api\/v1\/acessos\/(agente|papel|pessoa|grupo)\/([^/]+)$/.exec(p);
      if (!mm) { H.erroJson(res, 404, `Não existe ${m} ${p}.`); return true; }
      const nome = decodeURIComponent(mm[2]);
      if (m !== 'POST' && m !== 'DELETE') { H.erroJson(res, 405, 'Use POST para gravar ou DELETE para remover.'); return true; }
      if (mm[1] === 'agente') { if (m === 'DELETE') { H.erroJson(res, 405, 'Para tirar o agente do arquivo, mande POST com {"remover": true}.'); return true; } await editarAgente(req, res, nome); return true; }
      if (mm[1] === 'papel') { await editarPapel(req, res, nome, m); return true; }
      if (mm[1] === 'pessoa') { await editarPessoa(req, res, nome, m); return true; }
      await editarGrupo(req, res, nome, m);
      return true;
    } catch (e) {
      responderErro(res, e);
      return true;
    }
  }

  return { rotas, visao, efetivo, catalogoSkills };
}

module.exports = { criarAcessos };
