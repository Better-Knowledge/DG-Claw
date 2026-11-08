'use strict';
// Fonte "ferramenta-<nome>": o gateway para um sistema de fora (API HTTP, banco SQLite ou servidor MCP) descrito
// em /etc/dgclaw/ferramentas.json. O agente chama uma OPERAÇÃO do catálogo fechado, com parâmetros validados pelo
// esquema; o gateway injeta a credencial (que o agente nunca vê), chama o sistema e devolve o resultado com teto.
// Operação marcada como ação (escrita) nunca executa pelo pedido do agente: vira aprovação humana, e quem
// executa é o Web depois do clique. Cada chamada vira uma linha no log de acesso (dados.js).
//
// Limites de propósito: sem seguir redirecionamento, sem credencial em log ou erro, resposta até 1 MB, tempo
// até timeout_s (máximo 25 s, porque a caixa do agente responde em 30 s), ambiente do MCP limpo (só PATH, o
// env do catálogo e a credencial na variável combinada).

const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { ErroFonte } = require('./json');
const { validaParams } = require('./esquema');

const MAX_RESPOSTA = 1024 * 1024;
const MAX_ITENS_PADRAO = 200;
const MAX_ECO_LOG = 300;      // o que do erro do sistema vai para o LOG do Web (nunca para o agente)
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Credencial que o adaptador precisa, lida na hora. Erro vira 503 sem o valor. */
function credencialDe(cofre, f) {
  if (!f.credencial) return null;
  try { return cofre.ler(f.credencial); } catch (e) {
    throw new ErroFonte(503, `A ferramenta não pode ser usada agora: ${e.message}`);
  }
}

/** Troca toda ocorrência da credencial por *** num texto que vai para o log. */
function mascara(texto, credencial) {
  const t = String(texto || '');
  return credencial ? t.split(credencial).join('***') : t;
}

/** Só os campos de `campos` (quando a operação os declara), em cada item. */
function filtraCampos(v, campos) {
  if (!campos) return v;
  const um = (o) => { if (!ehObjeto(o)) return o; const s = {}; for (const c of campos) if (o[c] !== undefined) s[c] = o[c]; return s; };
  return Array.isArray(v) ? v.map(um) : um(v);
}

/** Resultado de API ou MCP no formato { itens } ou { item }, com teto de itens. */
function normalizaResultado(v, op) {
  const max = op.max_itens || MAX_ITENS_PADRAO;
  let lista = null;
  if (Array.isArray(v)) lista = v;
  else if (ehObjeto(v)) for (const k of ['itens', 'items', 'data', 'results', 'resultados']) if (Array.isArray(v[k])) { lista = v[k]; break; }
  if (lista) return { itens: filtraCampos(lista.slice(0, max), op.campos), total: lista.length, truncado: lista.length > max };
  return { item: filtraCampos(v, op.campos) };
}

// ── API HTTP ────────────────────────────────────────────────────────────────
/** Um valor que vai num segmento da rota: nunca vazio, nunca "." ou "..", nunca com barra; codificado. */
function segmentoDeRota(nome, v) {
  const t = String(v === undefined || v === null ? '' : v);
  if (!t || t === '.' || t === '..' || /[/\\?#]/.test(t) || /^\.+$/.test(t)) throw new ErroFonte(400, `"${nome}" não pode ser vazio, ".", ".." nem ter barra, "?" ou "#" quando entra na rota do sistema.`);
  return encodeURIComponent(t);
}

function montaUrl(f, op, params) {
  const usados = new Set();
  const rota = op.rota.replace(/\{([^}]+)\}/g, (_, n) => { usados.add(n); return segmentoDeRota(n, params[n]); });
  const u = new URL(f.base_url + rota);
  // A URL montada tem de ser o caminho literal do catálogo com os segmentos encaixados: nada de normalização.
  const esperado = new URL(f.base_url).pathname.replace(/\/+$/, '') + rota;
  if (u.pathname !== esperado) throw new ErroFonte(400, 'Os parâmetros mudariam o caminho da rota do sistema; recusado.');
  if (op.metodo === 'GET') for (const [k, v] of Object.entries(params)) if (!usados.has(k)) u.searchParams.set(k, String(v));
  const corpo = op.metodo === 'GET' ? null : Object.fromEntries(Object.entries(params).filter(([k]) => !usados.has(k)));
  return { url: u, corpo };
}

function chamaApi(f, op, params, credencial) {
  const { url, corpo } = montaUrl(f, op, params);
  const cab = { Accept: 'application/json', 'User-Agent': 'DG-Claw-gateway' };
  if (f.auth.tipo === 'bearer') cab.Authorization = `Bearer ${credencial}`;
  else if (f.auth.tipo === 'cabecalho') cab[f.auth.nome] = credencial;
  else if (f.auth.tipo === 'basico') cab.Authorization = `Basic ${Buffer.from(credencial, 'utf8').toString('base64')}`;
  let dados = null;
  if (corpo) { dados = Buffer.from(JSON.stringify(corpo), 'utf8'); cab['Content-Type'] = 'application/json'; cab['Content-Length'] = dados.length; }
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    // `timeout` é inatividade do socket; `signal` é o prazo total (um sistema que goteja bytes não segura a chamada).
    const req = mod.request(url, { method: op.metodo, headers: cab, timeout: f.timeout_s * 1000, signal: AbortSignal.timeout(f.timeout_s * 1000) }, (res) => {
      const partes = []; let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_RESPOSTA) { res.destroy(); reject(new ErroFonte(502, `A resposta do sistema passou de ${MAX_RESPOSTA} bytes e foi descartada. Peça menos (limit, filtro).`)); return; }
        partes.push(c);
      });
      res.on('error', (e) => reject(new ErroFonte(502, `A resposta do sistema foi interrompida (${e.code || e.message}).`)));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        if (res.statusCode >= 300 && res.statusCode < 400) { reject(new ErroFonte(502, `O sistema respondeu com redirecionamento (${res.statusCode}); o gateway não segue redirecionamento. Confira base_url e rota no catálogo.`)); return; }
        if (res.statusCode === 401 || res.statusCode === 403) { reject(new ErroFonte(502, `O sistema recusou a credencial do gateway (${res.statusCode}). O dono precisa conferir a credencial no cofre de sistemas.`)); return; }
        if (res.statusCode >= 400) {
          // O corpo do erro pode ecoar o cabeçalho de autorização: vai só para o log do Web, mascarado, nunca ao agente.
          if (f.log) f.log('aviso', `Ferramenta ${f.nomeF}/${op.nomeOp}: o sistema respondeu ${res.statusCode}: ${mascara(texto, credencial).slice(0, MAX_ECO_LOG).replace(/[\u0000-\u001f]/g, ' ')}`);
          reject(new ErroFonte(502, `O sistema respondeu ${res.statusCode} a "${op.nomeOp}". O motivo ficou no log do Web; se repetir, avise o dono.`)); return;
        }
        if (!texto.trim()) { resolve(null); return; }
        try { resolve(JSON.parse(texto)); } catch (e) { reject(new ErroFonte(502, `O sistema não respondeu em JSON (${e.message}); o gateway só repassa JSON.`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', (e) => reject(new ErroFonte(e.name === 'AbortError' || e.code === 'ABORT_ERR' ? 504 : 502, e.name === 'AbortError' || e.code === 'ABORT_ERR' ? `O sistema não respondeu em ${f.timeout_s} s.` : `Não consegui falar com o sistema (${e.code || e.message}). Se repetir, avise o dono.`)));
    if (dados) req.write(dados);
    req.end();
  });
}

// ── banco SQLite ────────────────────────────────────────────────────────────
// A consulta roda num worker (fora do event loop do Web) e tem o prazo da ferramenta: passou, o worker é
// encerrado e o agente recebe 504. Só os nomes de parâmetro que o SQL usa entram no bind.
function chamaBanco(f, op, params) {
  const bind = {};
  const usados = new Set([...op.sql.matchAll(/:([a-z][a-z0-9_]*)/g)].map((m) => m[1]));
  for (const [k, v] of Object.entries(params)) if (usados.has(k)) bind[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(path.join(__dirname, 'banco-worker.js'), { workerData: { arquivo: f.arquivo, sql: op.sql, bind, acao: !!op.acao, max: op.max_itens || MAX_ITENS_PADRAO } }); } catch (e) {
      reject(new ErroFonte(503, `Não consegui iniciar a consulta ao banco (${e.code || e.message}).`)); return;
    }
    let terminou = false;
    const fim = (fn) => { if (terminou) return; terminou = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => { w.terminate().catch(() => {}); fim(() => reject(new ErroFonte(504, `A consulta ao banco não terminou em ${f.timeout_s} s e foi interrompida. Peça um recorte menor.`))); }, f.timeout_s * 1000);
    w.on('message', (m) => fim(() => {
      if (m && m.erro) reject(new ErroFonte(m.erro.status, m.erro.mensagem));
      else if (m && m.ok) resolve(m.ok.campos === undefined && op.campos && m.ok.itens ? Object.assign(m.ok, { itens: filtraCampos(m.ok.itens, op.campos) }) : m.ok);
      else reject(new ErroFonte(502, 'A consulta ao banco devolveu algo inesperado.'));
    }));
    w.on('error', (e) => fim(() => reject(new ErroFonte(502, `A consulta ao banco falhou (${String(e.message).slice(0, 200)}).`))));
    w.on('exit', (c) => fim(() => reject(new ErroFonte(502, `A consulta ao banco encerrou sem resposta (código ${c}).`))));
  });
}

// ── servidor MCP (stdio, JSON-RPC) ─────────────────────────────────────────
function chamaMcp(f, op, params, credencial) {
  const env = Object.assign({ PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' }, f.env);
  if (f.credencial_env && credencial) env[f.credencial_env] = credencial;
  return new Promise((resolve, reject) => {
    let filho;
    // Grupo de processo próprio: no fim, o grupo inteiro recebe o sinal; um wrapper (npx, sh -c) não deixa neto vivo com a credencial no ambiente.
    try { filho = spawn(f.comando, f.args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }); } catch (e) { reject(new ErroFonte(503, `Não consegui iniciar o servidor MCP (${e.code || e.message}).`)); return; }
    let terminou = false; let saida = ''; let erros = ''; let id = 0;
    const pendentes = new Map();
    const mata = (sinal) => { try { process.kill(-filho.pid, sinal); } catch (_) { try { filho.kill(sinal); } catch (__) { /* já morreu */ } } };
    const fim = (fn) => {
      if (terminou) return; terminou = true; clearTimeout(timer);
      try { filho.stdin.end(); } catch (_) { /* já fechado */ }
      mata('SIGTERM');
      const t2 = setTimeout(() => mata('SIGKILL'), 2000); t2.unref();
      fn();
    };
    const timer = setTimeout(() => fim(() => reject(new ErroFonte(504, `O servidor MCP não respondeu em ${f.timeout_s} s.`))), f.timeout_s * 1000);
    const manda = (metodo, p, comId) => new Promise((res, rej) => {
      const msg = { jsonrpc: '2.0', method: metodo };
      if (p !== undefined) msg.params = p;
      if (comId) { msg.id = ++id; pendentes.set(msg.id, { res, rej }); } else res(null);
      filho.stdin.write(JSON.stringify(msg) + '\n');
    });
    filho.on('error', (e) => fim(() => reject(new ErroFonte(503, `O servidor MCP falhou ao iniciar (${e.code || e.message}).`))));
    filho.stderr.on('data', (c) => { if (erros.length < 4000) erros += c.toString('utf8'); });
    filho.on('exit', () => fim(() => {
      // O stderr do servidor pode mostrar o ambiente (modo debug): vai só para o log do Web, mascarado.
      if (f.log && erros.trim()) f.log('aviso', `Ferramenta ${f.nomeF}/${op.nomeOp}: o servidor MCP encerrou antes de responder; stderr: ${mascara(erros, credencial).trim().slice(0, MAX_ECO_LOG).replace(/[\u0000-\u001f]/g, ' ')}`);
      reject(new ErroFonte(502, 'O servidor MCP encerrou antes de responder. O motivo ficou no log do Web; se repetir, avise o dono.'));
    }));
    filho.stdin.on('error', () => { /* o servidor fechou o stdin: o exit/timeout cuida */ });
    filho.stdout.on('data', (c) => {
      saida += c.toString('utf8');
      if (saida.length > MAX_RESPOSTA) { fim(() => reject(new ErroFonte(502, `A resposta do servidor MCP passou de ${MAX_RESPOSTA} bytes.`))); return; }
      let i;
      while ((i = saida.indexOf('\n')) >= 0) {
        const linha = saida.slice(0, i).trim(); saida = saida.slice(i + 1);
        if (!linha) continue;
        let m; try { m = JSON.parse(linha); } catch (_) { continue; }
        if (m && m.id !== undefined && pendentes.has(m.id)) { const p = pendentes.get(m.id); pendentes.delete(m.id); if (m.error) p.rej(m.error); else p.res(m.result); }
      }
    });
    (async () => {
      await manda('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dgclaw-gateway', version: '1' } }, true);
      await manda('notifications/initialized', undefined, false);
      const r = await manda('tools/call', { name: op.tool, arguments: params }, true);
      fim(() => resolve(r));
    })().catch((e) => fim(() => reject(new ErroFonte(502, `O servidor MCP recusou a chamada (${e && e.message ? String(e.message).slice(0, 200) : JSON.stringify(e).slice(0, 200)}).`))));
  });
}

/** O resultado de tools/call: o texto dos blocos (JSON quando parsear) ou o objeto estruturado. */
function desembrulhaMcp(r) {
  if (!ehObjeto(r)) return r;
  if (r.isError) throw new ErroFonte(502, `A tool do servidor MCP devolveu erro: ${JSON.stringify(r.content || r).slice(0, 300)}`);
  if (r.structuredContent !== undefined) return r.structuredContent;
  if (Array.isArray(r.content)) {
    const textos = r.content.filter((c) => c && c.type === 'text').map((c) => c.text);
    if (textos.length === 1) { try { return JSON.parse(textos[0]); } catch (_) { return { texto: textos[0] }; } }
    return { textos };
  }
  return r;
}

function fonteFerramenta({ nome, ferramenta: fDef, cofre, log }) {
  const f = Object.assign({}, fDef, { log, nomeF: nome });
  const ops = {}; const acoes = {};
  for (const [nomeOp, opDef] of Object.entries(f.operacoes)) {
    const op = Object.assign({}, opDef, { nomeOp });
    const executa = async (params) => {
      const cred = credencialDe(cofre, f);
      if (f.tipo === 'api') return normalizaResultado(await chamaApi(f, op, params, cred), op);
      if (f.tipo === 'banco') return chamaBanco(f, op, params);
      return normalizaResultado(desembrulhaMcp(await chamaMcp(f, op, params, cred)), op);
    };
    if (op.acao) {
      acoes[nomeOp] = {
        acao: `ferramenta:${nomeOp}`,
        escopo: op.escopo,
        validar: (p) => validaParams(op.params, p || {}, `${nomeOp} em ferramenta-${nome}`),
        executar: (p, contexto) => executa(p).then((r) => { if (log) log('info', `Ferramenta ${nome}: ${nomeOp} executada a pedido de ${contexto.agente} (aprovação ${contexto.aprovacao}).`); return r; }),
      };
    } else {
      ops[nomeOp] = Object.assign((p) => executa(validaParams(op.params, p || {}, `${nomeOp} em ferramenta-${nome}`)), { escopo: op.escopo });
    }
  }
  return {
    nome: `ferramenta-${nome}`, ferramenta: nome, tipo: f.tipo, titulo: f.titulo,
    catalogo: Object.assign({}, f.catalogo, { tipo: f.tipo, titulo: f.titulo }),
    campos: [], assincrona: true,
    operacoes: ops, acoes,
    /** Para GET /fontes: operação -> escopo e esquema, para o agente saber o que mandar. */
    descricaoOps() {
      const d = {};
      for (const [n, op] of Object.entries(f.operacoes)) d[n] = { escopo: op.escopo, acao: op.acao, descricao: op.descricao, params: op.params };
      return d;
    },
  };
}

module.exports = { fonteFerramenta, montaUrl, segmentoDeRota, mascara, normalizaResultado, filtraCampos, desembrulhaMcp };
