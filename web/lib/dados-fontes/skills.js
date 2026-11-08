'use strict';
// Fonte "skills": o agente PROPÕE uma skill para o grupo da pessoa dele (ação propor_skill); uma pessoa aprova
// no painel e só então o Web grava em <skillsDir>/grupos/<grupo>/<nome>/SKILL.md (root, 755/644), que os
// agentes do grupo recebem no próximo `dgclaw skill aplicar` ou `agente reparar`. Nunca grava no escopo global
// (só o dono publica ali, pela CLI). Listar mostra ao agente o catálogo compartilhado; o que ele de fato tem
// está em ~/.claude/skills. Contrato em web/docs/SKILLS-POR-ESCOPO.md.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ErroFonte, soChaves, limiteDe, semInvisivel } = require('./json');

const RX_NOME = /^[a-z][a-z0-9-]{0,39}$/;
const RX_GRUPO = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_CONTEUDO = 60 * 1024;
const RX_SEGREDO = /sk-[A-Za-z0-9_-]{16,}|xox[abp]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(api[_-]?key|token|senha|password|secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/i;

function fonteSkills({ dir, papeis, log, catalogo }) {
  function lista() {
    const saida = [];
    const le = (escopo, pasta) => {
      let nomes = [];
      try { nomes = fs.readdirSync(pasta, { withFileTypes: true }); } catch (_) { return; }
      for (const d of nomes) {
        if (!d.isDirectory() || !RX_NOME.test(d.name)) continue;
        let st;
        try { st = fs.statSync(path.join(pasta, d.name, 'SKILL.md')); } catch (_) { continue; }
        saida.push({ nome: d.name, escopo, tamanho: st.size, modificado_em: new Date(st.mtimeMs).toISOString() });
      }
    };
    le('global', path.join(dir, 'globais'));
    let grupos = [];
    try { grupos = fs.readdirSync(path.join(dir, 'grupos'), { withFileTypes: true }).filter((d) => d.isDirectory() && RX_GRUPO.test(d.name)).map((d) => d.name); } catch (_) { grupos = []; }
    for (const g of grupos.sort()) le(`grupo:${g}`, path.join(dir, 'grupos', g));
    return saida;
  }

  return {
    nome: 'skills', catalogo,
    campos: ['nome', 'escopo', 'tamanho', 'modificado_em'],
    operacoes: {
      listar(q) {
        soChaves(q || {}, ['limit'], 'listar em skills');
        const lim = limiteDe(q);
        const todos = lista();
        return { itens: todos.slice(0, lim), total: todos.length };
      },
    },
    acoes: {
      propor: {
        acao: 'propor_skill',
        /** `contexto` (quando vem da rota) traz { pessoa, papel, politica }: o grupo tem de ser da pessoa. */
        validar(p, contexto) {
          soChaves(p || {}, ['nome', 'grupo', 'conteudo'], 'propor em skills');
          if (typeof p.nome !== 'string' || !RX_NOME.test(p.nome)) throw new ErroFonte(400, '"nome" é obrigatório: minúsculas, números e hífen, começando por letra, até 40 (ex.: fechamento-mensal).');
          if (typeof p.grupo !== 'string' || !RX_GRUPO.test(p.grupo)) throw new ErroFonte(400, '"grupo" é obrigatório: o nome de um grupo de que a sua pessoa faz parte.');
          if (typeof p.conteudo !== 'string' || !p.conteudo.trim()) throw new ErroFonte(400, '"conteudo" é obrigatório: o SKILL.md inteiro, com o frontmatter (name, description).');
          if (Buffer.byteLength(p.conteudo, 'utf8') > MAX_CONTEUDO) throw new ErroFonte(413, `"conteudo" passa de ${MAX_CONTEUDO} bytes.`);
          semInvisivel(p.conteudo, '"conteudo"');
          const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(p.conteudo);
          if (!m) throw new ErroFonte(400, 'O "conteudo" precisa começar pelo frontmatter (--- name: ... description: ... ---), como toda skill.');
          const nomeFm = /^name:\s*(.+)$/m.exec(m[1]);
          if (!nomeFm || nomeFm[1].trim() !== p.nome) throw new ErroFonte(400, `O frontmatter diz name: ${nomeFm ? nomeFm[1].trim() : '(nada)'}, mas a skill se chama ${p.nome}; os dois precisam ser iguais.`);
          if (!/^description:\s*\S/m.test(m[1])) throw new ErroFonte(400, 'O frontmatter precisa ter "description" (quando usar a skill).');
          if (RX_SEGREDO.test(p.conteudo)) throw new ErroFonte(400, 'O "conteudo" parece ter um segredo (chave, token ou senha). Skill diz ONDE pegar a chave, nunca o valor.');
          if (contexto && contexto.politica) {
            const pessoa = contexto.politica.pessoas[contexto.pessoa];
            if (!pessoa || !pessoa.grupos.includes(p.grupo)) throw new ErroFonte(403, `A pessoa ${contexto.pessoa} não faz parte do grupo "${p.grupo}"; só dá para propor skill para um grupo seu.`);
          }
          return { nome: p.nome, grupo: p.grupo, conteudo: p.conteudo };
        },
        executar(p, contexto) {
          const pasta = path.join(dir, 'grupos', p.grupo, p.nome);
          const destino = path.join(pasta, 'SKILL.md');
          let existia = false;
          try { existia = fs.lstatSync(destino).isFile(); } catch (_) { existia = false; }
          try {
            for (const d of [dir, path.join(dir, 'grupos'), path.join(dir, 'grupos', p.grupo), pasta]) {
              let st = null;
              try { st = fs.lstatSync(d); } catch (e) { if (e.code !== 'ENOENT') throw e; }
              if (!st) { fs.mkdirSync(d, { mode: 0o755 }); continue; }
              if (st.isSymbolicLink() || !st.isDirectory()) throw new ErroFonte(403, 'O caminho da skill passa por um atalho ou por algo que não é pasta; recusado.');
            }
            const tmp = path.join(pasta, `.SKILL.${crypto.randomBytes(4).toString('hex')}.tmp`);
            const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
            try { fs.writeSync(fd, p.conteudo); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            fs.renameSync(tmp, destino);
          } catch (e) {
            if (e instanceof ErroFonte) throw e;
            throw new ErroFonte(503, `Não consegui gravar a skill (${e.code || e.message}). Nada foi alterado.`);
          }
          if (log) log('info', `Skills: ${existia ? 'substituída' : 'criada'} grupos/${p.grupo}/${p.nome} a pedido de ${contexto.agente} (aprovação ${contexto.aprovacao}). Os agentes do grupo a recebem no próximo "dgclaw skill aplicar".`);
          return { gravada: true, escopo: `grupo:${p.grupo}`, nome: p.nome, substituiu: existia, proximo_passo: 'Peça à pessoa que o Admin rode "sudo dgclaw skill aplicar" para a skill entrar nos agentes do grupo.' };
        },
      },
    },
  };
}

module.exports = { fonteSkills, RX_SEGREDO };
