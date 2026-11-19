'use strict';
// Fonte "pasta": documentos de texto numa pasta do host (<dir>/pasta/), lidos pelo Web como root.
// Por isso o caminho que o agente manda nunca é usado direto: é resolvido, conferido contra a raiz real
// da pasta e só então aberto, sem seguir atalho. "../", caminho absoluto, atalho para fora, pasta no lugar
// de arquivo e arquivo grande demais voltam como erro, e nada é lido.

const fs = require('node:fs');
const path = require('node:path');
const { ErroFonte, soChaves, limiteDe } = require('./json');

const MAX_ARQUIVO = 256 * 1024;
const MAX_CAMINHO = 300;
const EXTENSOES = new Set(['.md', '.txt', '.csv', '.json']);
const RX_PARTE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,100}$/;

function fontePasta({ dir, nome, log, catalogo }) {
  const raiz = path.join(dir, nome);

  function raizReal() {
    try { return fs.realpathSync(raiz); } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new ErroFonte(503, `A pasta da fonte "${nome}" não pôde ser aberta (${e.code || e.message}). Avise o dono.`);
    }
  }

  /** Confere um caminho relativo vindo do agente. Devolve { rel, abs } já dentro da raiz real, ou lança. */
  function resolve(bruto) {
    if (typeof bruto !== 'string' || !bruto || bruto.length > MAX_CAMINHO) throw new ErroFonte(400, `"caminho" é obrigatório: o caminho relativo do arquivo dentro da pasta, com até ${MAX_CAMINHO} caracteres (como está em listar).`);
    if (path.isAbsolute(bruto) || bruto.includes('\\') || /[\x00-\x1f\x7f]/.test(bruto)) throw new ErroFonte(400, 'O "caminho" precisa ser relativo à pasta, sem barra invertida nem caracteres de controle.');
    const partes = bruto.split('/');
    if (partes.some((p) => !RX_PARTE.test(p) || p === '..' || p === '.')) throw new ErroFonte(400, `O "caminho" ${JSON.stringify(bruto.slice(0, 80))} tem uma parte que não vale: só letras, números, espaço, ponto, sublinhado e hífen, sem "." nem ".." como nome, sem começar por ponto.`);
    const base = raizReal();
    if (!base) throw new ErroFonte(404, `A pasta da fonte "${nome}" ainda não existe no servidor; o dono precisa criá-la.`);
    const abs = path.resolve(base, ...partes);
    if (!abs.startsWith(base + path.sep)) throw new ErroFonte(403, 'O "caminho" sai da pasta liberada; recusado.');
    // Nenhuma parte do caminho pode ser atalho: o realpath do destino tem de ser o próprio caminho.
    let real;
    try { real = fs.realpathSync(abs); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw new ErroFonte(404, `Não existe ${JSON.stringify(bruto.slice(0, 80))} na pasta.`);
      throw new ErroFonte(403, `Não consegui conferir ${JSON.stringify(bruto.slice(0, 80))} (${e.code || e.message}); recusado.`);
    }
    if (real !== abs) {
      if (log) log('aviso', `Fonte pasta: ${abs} aponta para ${real} (atalho); recusei a leitura.`);
      throw new ErroFonte(403, `${JSON.stringify(bruto.slice(0, 80))} é um atalho ou passa por um; a fonte só lê arquivos comuns dentro da pasta.`);
    }
    return { rel: partes.join('/'), abs };
  }

  function listaRecursiva(base, rel, saida) {
    let nomes;
    try { nomes = fs.readdirSync(path.join(base, rel), { withFileTypes: true }); } catch (e) {
      throw new ErroFonte(503, `Não consegui listar a pasta (${e.code || e.message}).`);
    }
    for (const d of nomes.sort((a, b) => a.name.localeCompare(b.name))) {
      if (d.name.startsWith('.') || !RX_PARTE.test(d.name)) continue;      // nome fora do padrão nem aparece
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isSymbolicLink()) continue;                                      // atalho nem é listado
      if (d.isDirectory()) { listaRecursiva(base, r, saida); continue; }
      if (!d.isFile() || !EXTENSOES.has(path.extname(d.name).toLowerCase())) continue;
      let st;
      try { st = fs.lstatSync(path.join(base, r)); } catch (_) { continue; }
      saida.push({ caminho: r, tamanho: st.size, modificado_em: new Date(st.mtimeMs).toISOString() });
      if (saida.length >= 2000) return;
    }
  }

  return {
    nome, catalogo,
    campos: ['caminho', 'tamanho', 'modificado_em', 'conteudo'],
    operacoes: {
      listar(q) {
        soChaves(q || {}, ['limit'], `listar em ${nome}`);
        const lim = limiteDe(q);
        const base = raizReal();
        if (!base) return { itens: [], total: 0 };
        const todos = [];
        listaRecursiva(base, '', todos);
        return { itens: todos.slice(0, lim), total: todos.length };
      },
      buscar(q) {
        soChaves(q || {}, ['termo', 'limit'], `buscar em ${nome}`);
        if (typeof q.termo !== 'string' || !q.termo.trim()) throw new ErroFonte(400, '"termo" é obrigatório e precisa ser um texto.');
        const termo = q.termo.trim().toLowerCase().slice(0, 200);
        const lim = limiteDe(q);
        const base = raizReal();
        if (!base) return { itens: [], total: 0 };
        const todos = [];
        listaRecursiva(base, '', todos);
        const achados = todos.filter((it) => it.caminho.toLowerCase().includes(termo));
        return { itens: achados.slice(0, lim), total: achados.length };
      },
      ler(q) {
        soChaves(q || {}, ['caminho'], `ler em ${nome}`);
        const { rel, abs } = resolve(q && q.caminho);
        if (!EXTENSOES.has(path.extname(abs).toLowerCase())) throw new ErroFonte(403, `A fonte só lê texto (${[...EXTENSOES].join(', ')}).`);
        let fd = null;
        try {
          fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          const st = fs.fstatSync(fd);
          if (!st.isFile()) throw new ErroFonte(403, `${JSON.stringify(rel)} não é um arquivo comum.`);
          if (st.size > MAX_ARQUIVO) throw new ErroFonte(413, `${JSON.stringify(rel)} tem ${st.size} bytes e o teto de leitura é ${MAX_ARQUIVO}. Peça ao dono um arquivo menor.`);
          const buf = Buffer.alloc(st.size);
          let lidos = 0;
          while (lidos < st.size) { const n = fs.readSync(fd, buf, lidos, st.size - lidos, lidos); if (n === 0) break; lidos += n; }
          return { item: { caminho: rel, tamanho: st.size, modificado_em: new Date(st.mtimeMs).toISOString(), conteudo: buf.toString('utf8', 0, lidos) } };
        } catch (e) {
          if (e instanceof ErroFonte) throw e;
          throw new ErroFonte(e.code === 'ENOENT' ? 404 : 403, `Não consegui ler ${JSON.stringify(rel)} (${e.code || e.message}).`);
        } finally {
          if (fd != null) { try { fs.closeSync(fd); } catch (_) { /* já fechado */ } }
        }
      },
    },
    acoes: {},
  };
}

module.exports = { fontePasta, MAX_ARQUIVO };
