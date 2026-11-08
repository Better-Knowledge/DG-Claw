'use strict';
// Fonte "skills": o agente PROPÕE uma skill para o grupo da pessoa dele (ação propor_skill); uma pessoa aprova
// no painel e só então o Web grava em <skillsDir>/grupos/<grupo>/<nome>/SKILL.md (root, 755/644), que os
// agentes do grupo recebem no próximo `dgclaw skill aplicar` ou `agente reparar`. Nunca grava no escopo global
// (só o dono publica ali, pela CLI). Listar mostra ao agente o catálogo compartilhado; o que ele de fato tem
// está em ~/.claude/skills. Contrato em web/docs/SKILLS-POR-ESCOPO.md.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ErroFonte, soChaves, semInvisivel } = require('./json');

const RX_NOME = /^[a-z][a-z0-9-]{0,39}$/;
const RX_GRUPO = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_CONTEUDO = 60 * 1024;
const RAIZ_APP = path.join(__dirname, '..', '..', '..');
/** Os mesmos padrões de segredo que o dgclaw skill publicar usa (lib/segredos.regex): uma lista só. */
function carregaSegredos(arquivo) {
  const linhas = fs.readFileSync(arquivo, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  // [[:space:]] é POSIX; em JS vira \s. O resto dos padrões é ERE que o JS entende.
  return new RegExp(linhas.map((l) => '(?:' + l.replace(/\[\[:space:\]\]/g, '\\s') + ')').join('|'), 'i');
}
const RX_SEGREDO = carregaSegredos(path.join(RAIZ_APP, 'lib', 'segredos.regex'));
/** Nomes das skills da imagem e do Admin (pastas de skills/): uma compartilhada com esse nome tomaria o lugar da nativa. */
function nomesReservados() {
  try { return new Set(fs.readdirSync(path.join(RAIZ_APP, 'skills')).concat(['dgclaw'])); } catch (_) { return new Set(['dgclaw']); }
}

function fonteSkills({ dir, papeis, log, catalogo }) {
  const reservados = nomesReservados();
  /** null se não existe; { outros: true } se a pasta tem mais que o SKILL.md (publicada pela CLI com arquivos). */
  function existeSkill(grupo, nome) {
    const pasta = path.join(dir, 'grupos', grupo, nome);
    let st; try { st = fs.lstatSync(path.join(pasta, 'SKILL.md')); } catch (_) { return null; }
    if (!st.isFile()) return null;
    let outros = false;
    try { outros = fs.readdirSync(pasta).some((n) => n !== 'SKILL.md' && !n.startsWith('.')); } catch (_) { outros = false; }
    return { outros, bytes: st.size, modificado_em: new Date(st.mtimeMs).toISOString() };
  }
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
    campos: [],
    // Só ação: o que o agente tem está em ~/.claude/skills; o catálogo dos outros escopos não é dele.
    operacoes: {},
    acoes: {
      propor: {
        acao: 'propor_skill',
        /** `contexto` (quando vem da rota) traz { pessoa, papel, politica }: o grupo tem de ser da pessoa. */
        validar(p, contexto) {
          soChaves(p || {}, ['nome', 'grupo', 'conteudo', 'substituir'], 'propor em skills');
          if (typeof p.nome !== 'string' || !RX_NOME.test(p.nome)) throw new ErroFonte(400, '"nome" é obrigatório: minúsculas, números e hífen, começando por letra, até 40 (ex.: fechamento-mensal).');
          if (reservados.has(p.nome)) throw new ErroFonte(400, `"${p.nome}" é o nome de uma skill da imagem do DG Claw; uma skill compartilhada com esse nome tomaria o lugar dela. Escolha outro nome (ex.: ${p.nome}-da-empresa).`);
          if (p.substituir !== undefined && typeof p.substituir !== 'boolean') throw new ErroFonte(400, '"substituir" precisa ser true ou false.');
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
          const existe = existeSkill(p.grupo, p.nome);
          if (existe && !p.substituir) throw new ErroFonte(409, `Já existe a skill "${p.nome}" no grupo ${p.grupo}. Para trocar o texto, proponha de novo com "substituir": true; a pessoa vai ver que é uma substituição.`);
          if (existe && existe.outros) throw new ErroFonte(409, `A skill "${p.nome}" do grupo ${p.grupo} foi publicada pelo dono com mais arquivos além do SKILL.md; um agente não a substitui. Peça ao dono.`);
          return { nome: p.nome, grupo: p.grupo, conteudo: p.conteudo, substituir: p.substituir === true };
        },
        executar(p, contexto) {
          // Reconfere na hora da aprovação: a pessoa ainda está no grupo? (ela pode ter saído entre pedir e aprovar)
          if (papeis && contexto && contexto.agente) {
            const e = papeis.estado();
            const ag = e.ok ? e.politica.agentes[contexto.agente] : null;
            const pessoa = ag ? e.politica.pessoas[ag.pessoa] : null;
            if (!pessoa || pessoa.estado === 'desligada' || !pessoa.grupos.includes(p.grupo)) throw new ErroFonte(403, `A pessoa do agente ${contexto.agente} já não faz parte do grupo "${p.grupo}"; a skill não foi gravada.`);
          }
          const pasta = path.join(dir, 'grupos', p.grupo, p.nome);
          const destino = path.join(pasta, 'SKILL.md');
          const existe = existeSkill(p.grupo, p.nome);
          if (existe && !p.substituir) throw new ErroFonte(409, `Já existe a skill "${p.nome}" no grupo ${p.grupo}; o pedido não tinha "substituir": true.`);
          if (existe && existe.outros) throw new ErroFonte(409, `A skill "${p.nome}" tem outros arquivos além do SKILL.md (publicada pelo dono); um agente não a substitui.`);
          const existia = !!existe;
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

module.exports = { fonteSkills, RX_SEGREDO, nomesReservados, carregaSegredos };
