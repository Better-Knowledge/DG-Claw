'use strict';
// Fonte "base-<nome>": uma base de conhecimento, isto é, a pasta de texto <basesDir>/<nome>/ (Markdown, txt,
// csv, json). Lê e busca como a fonte "pasta" (mesma conferência de caminho real, sem atalho, teto por
// arquivo) e, além disso, busca DENTRO do texto, devolvendo o trecho em volta do termo. A escrita é uma
// ação ("escrever_base"): o agente propõe um arquivo, uma pessoa aprova no painel, e só então o Web grava,
// de forma atômica, dentro da pasta da base. Nunca sobrescreve sem "substituir": true.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ErroFonte, soChaves, limiteDe, semInvisivel } = require('./json');
const { fontePasta, MAX_ARQUIVO } = require('./pasta');

const MAX_TRECHO = 240;
const MAX_ARQUIVOS_BUSCA = 500;              // arquivos lidos por busca
const MAX_BYTES_BUSCA = 8 * 1024 * 1024;     // bytes lidos por busca
const MAX_CONTEUDO = 60 * 1024;              // o corpo do pedido tem teto de 64 KB (dados.js): a proposta cabe nele
const EXTENSOES_ESCRITA = new Set(['.md', '.txt']);

function tokens(termo) {
  return termo.toLowerCase().split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 8);
}

/** Trecho de até MAX_TRECHO caracteres em volta da primeira ocorrência de qualquer token. */
function trechoDe(texto, toks) {
  const baixo = texto.toLowerCase();
  let pos = -1;
  for (const t of toks) { const i = baixo.indexOf(t); if (i >= 0 && (pos < 0 || i < pos)) pos = i; }
  if (pos < 0) return '';
  const ini = Math.max(0, pos - Math.floor(MAX_TRECHO / 3));
  const fim = Math.min(texto.length, ini + MAX_TRECHO);
  return (ini > 0 ? '…' : '') + texto.slice(ini, fim).replace(/\s+/g, ' ').trim() + (fim < texto.length ? '…' : '');
}

function fonteBase({ dir, nome, base, log, catalogo }) {
  const pasta = fontePasta({ dir, nome, log, catalogo });
  const raiz = path.join(dir, nome);

  function raizReal() {
    try { return fs.realpathSync(raiz); } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new ErroFonte(503, `A pasta da base "${nome}" não pôde ser aberta (${e.code || e.message}). Avise o dono.`);
    }
  }

  return {
    nome: `base-${nome}`, base: nome, catalogo,
    campos: ['caminho', 'tamanho', 'modificado_em', 'trecho', 'conteudo'],
    operacoes: {
      listar: (q) => pasta.operacoes.listar(q),
      ler: (q) => pasta.operacoes.ler(q),
      /** Busca pelo nome do arquivo E pelo conteúdo (todos os termos precisam aparecer), com um trecho. */
      buscar(q) {
        soChaves(q || {}, ['termo', 'limit'], `buscar em base-${nome}`);
        if (typeof q.termo !== 'string' || !q.termo.trim()) throw new ErroFonte(400, '"termo" é obrigatório e precisa ser um texto.');
        if (q.termo.length > 200) throw new ErroFonte(400, '"termo" tem mais de 200 caracteres.');
        const toks = tokens(q.termo);
        if (!toks.length) throw new ErroFonte(400, '"termo" precisa ter ao menos uma palavra com 2 ou mais letras.');
        const lim = limiteDe(q);
        const base = raizReal();
        if (!base) return { itens: [], total: 0, arquivos_lidos: 0, truncado: false };
        const todos = pasta.listarTodos(MAX_ARQUIVOS_BUSCA + 1);
        const achados = [];
        let lidos = 0; let bytes = 0; let truncado = todos.length > MAX_ARQUIVOS_BUSCA;
        for (const it of todos.slice(0, MAX_ARQUIVOS_BUSCA)) {
          if (bytes + it.tamanho > MAX_BYTES_BUSCA) { truncado = true; break; }
          lidos++; bytes += it.tamanho;
          let texto = '';
          try { texto = pasta.operacoes.ler({ caminho: it.caminho }).item.conteudo; } catch (_) { continue; }   // arquivo que não dá para ler não entra
          const alvo = (it.caminho + '\n' + texto).toLowerCase();
          if (!toks.every((t) => alvo.includes(t))) continue;
          achados.push({ caminho: it.caminho, tamanho: it.tamanho, modificado_em: it.modificado_em, trecho: trechoDe(texto, toks) || trechoDe(it.caminho, toks) });
        }
        // `truncado` avisa que a base é maior do que uma busca lê: "não achei" não quer dizer "não existe".
        return { itens: achados.slice(0, lim), total: achados.length, arquivos_lidos: lidos, truncado };
      },
    },
    acoes: {
      propor: {
        acao: 'escrever_base',
        validar(p) {
          soChaves(p || {}, ['caminho', 'conteudo', 'substituir'], `propor em base-${nome}`);
          if (typeof p.caminho !== 'string' || !p.caminho) throw new ErroFonte(400, '"caminho" é obrigatório: onde o arquivo fica dentro da base (ex.: procedimentos/fechamento.md).');
          if (p.caminho.length > 300 || path.isAbsolute(p.caminho) || p.caminho.includes('\\') || /[\u0000-\u001f\u007f]/.test(p.caminho)) throw new ErroFonte(400, 'O "caminho" precisa ser relativo à base, sem barra invertida nem caracteres de controle, até 300 caracteres.');
          const partes = p.caminho.split('/');
          if (partes.some((x) => !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,100}$/.test(x) || x === '.' || x === '..')) throw new ErroFonte(400, `O "caminho" ${JSON.stringify(p.caminho.slice(0, 80))} tem uma parte que não vale: só letras, números, espaço, ponto, sublinhado e hífen, sem "." nem ".." como nome, sem começar por ponto.`);
          if (!EXTENSOES_ESCRITA.has(path.extname(p.caminho).toLowerCase())) throw new ErroFonte(400, 'Só dá para propor arquivos .md ou .txt.');
          if (typeof p.conteudo !== 'string' || !p.conteudo.trim()) throw new ErroFonte(400, '"conteudo" é obrigatório: o texto do arquivo.');
          if (Buffer.byteLength(p.conteudo, 'utf8') > MAX_CONTEUDO) throw new ErroFonte(413, `"conteudo" passa de ${MAX_CONTEUDO} bytes.`);
          semInvisivel(p.conteudo, '"conteudo"');
          if (p.substituir !== undefined && typeof p.substituir !== 'boolean') throw new ErroFonte(400, '"substituir" precisa ser true ou false.');
          return { caminho: partes.join('/'), conteudo: p.conteudo, substituir: p.substituir === true };
        },
        executar(p, contexto) {
          let base = raizReal();
          if (!base) {
            try { fs.mkdirSync(raiz, { recursive: true, mode: 0o700 }); base = fs.realpathSync(raiz); } catch (e) { throw new ErroFonte(503, `Não consegui criar a pasta da base "${nome}" (${e.code || e.message}).`); }
          }
          const partes = p.caminho.split('/');
          const destino = path.resolve(base, ...partes);
          if (!destino.startsWith(base + path.sep)) throw new ErroFonte(403, 'O "caminho" sai da base; recusado.');
          // Cada pasta intermediária: não pode ser atalho; é criada se faltar.
          let atual = base;
          for (const parte of partes.slice(0, -1)) {
            atual = path.join(atual, parte);
            let st = null;
            try { st = fs.lstatSync(atual); } catch (e) { if (e.code !== 'ENOENT') throw new ErroFonte(503, `Não consegui conferir ${parte} (${e.code || e.message}).`); }
            if (!st) { try { fs.mkdirSync(atual, { mode: 0o700 }); } catch (e) { throw new ErroFonte(503, `Não consegui criar a pasta ${parte} (${e.code || e.message}).`); } continue; }
            if (st.isSymbolicLink() || !st.isDirectory()) throw new ErroFonte(403, `${parte} é um atalho ou não é pasta; recusado.`);
          }
          let existente = null;
          try { existente = fs.lstatSync(destino); } catch (e) { if (e.code !== 'ENOENT') throw new ErroFonte(503, `Não consegui conferir o destino (${e.code || e.message}).`); }
          if (existente && (existente.isSymbolicLink() || !existente.isFile())) throw new ErroFonte(403, 'O destino é um atalho ou não é um arquivo comum; recusado.');
          if (existente && !p.substituir) throw new ErroFonte(409, `Já existe ${JSON.stringify(p.caminho)} na base. Para trocar o conteúdo, proponha de novo com "substituir": true.`);
          const tmp = path.join(path.dirname(destino), `.${path.basename(destino)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
          try {
            const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
            try { fs.writeSync(fd, p.conteudo); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            fs.renameSync(tmp, destino);
          } catch (e) {
            try { fs.unlinkSync(tmp); } catch (_) { /* não chegou a existir */ }
            throw new ErroFonte(503, `Não consegui gravar o arquivo na base (${e.code || e.message}). Nada foi alterado.`);
          }
          if (log) log('info', `Base ${nome}: ${existente ? 'substituído' : 'criado'} ${p.caminho} (${Buffer.byteLength(p.conteudo, 'utf8')} bytes) a pedido de ${contexto.agente}, aprovado por uma pessoa (aprovação ${contexto.aprovacao}).`);
          return { gravado: true, caminho: p.caminho, substituiu: !!existente, bytes: Buffer.byteLength(p.conteudo, 'utf8') };
        },
      },
    },
  };
}

module.exports = { fonteBase, tokens, trechoDe };
