'use strict';
// Fonte "skills": o agente PROPÕE uma skill para o grupo da pessoa dele (ação propor_skill); uma pessoa aprova
// no painel e só então o Web grava em <skillsDir>/grupos/<grupo>/<nome>/SKILL.md (root, 755/644), que os
// agentes do grupo recebem no próximo `dgclaw skill aplicar` ou `agente reparar`. Nunca grava no escopo global
// (só o dono publica ali, pela CLI). A fonte é só ação: o que o agente tem está em ~/.claude/skills, e o
// catálogo dos outros escopos não é dele. Contrato em web/docs/SKILLS-POR-ESCOPO.md.

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
  if (!linhas.length) throw new Error('lib/segredos.regex: a lista de padrões de segredo está vazia.');
  // [[:space:]] é POSIX; em JS vira \s. O resto dos padrões é ERE que o JS entende. Outra classe POSIX ([[:alnum:]]
  // etc.) viraria em silêncio uma classe errada em JS: é recusada para a lista continuar igual nos dois lados.
  for (const l of linhas) {
    const resto = l.replace(/\[\[:space:\]\]/g, '');
    if (/\[\[:/.test(resto)) throw new Error(`lib/segredos.regex: a linha "${l}" usa uma classe POSIX que o Web não traduz; só [[:space:]] é aceita.`);
  }
  return new RegExp(linhas.map((l) => '(?:' + l.replace(/\[\[:space:\]\]/g, '\\s') + ')').join('|'), 'i');
}
const RX_SEGREDO = carregaSegredos(path.join(RAIZ_APP, 'lib', 'segredos.regex'));
/** As skills que o dgclaw liga em todo agente: lista fixa (a mesma de lib/skills.sh), unida ao que a pasta skills/ tem. */
const RESERVADAS_FIXAS = ['dgclaw', 'agenda', 'lembretes', 'aprender', 'avisos', 'memory', 'foco', 'avatar', 'report', 'slide-animado', 'site-animado', 'video-animado', 'groq-audio', 'gemini-gratuito', 'visuais-na-conversa'];
/**
 * Nomes das skills da imagem e do Admin (pastas de skills/ mais a lista fixa): uma compartilhada com esse nome tomaria
 * o lugar da nativa. `ok: false` quando a pasta skills/ não existe (cópia do app incompleta): propor fecha, não abre.
 */
function nomesReservados(raiz = RAIZ_APP) {
  try { return { ok: true, nomes: new Set(fs.readdirSync(path.join(raiz, 'skills')).concat(RESERVADAS_FIXAS)) }; } catch (_) { return { ok: false, nomes: new Set(RESERVADAS_FIXAS) }; }
}

function fonteSkills({ dir, papeis, log, catalogo }) {
  function existeGlobal(nome) { try { return fs.statSync(path.join(dir, 'globais', nome, 'SKILL.md')).isFile(); } catch (_) { return false; } }
  /** null se não existe; { outros: true } se a pasta tem mais que o SKILL.md (publicada pela CLI com arquivos). */
  function existeSkill(grupo, nome) {
    const pasta = path.join(dir, 'grupos', grupo, nome);
    let st; try { st = fs.lstatSync(path.join(pasta, 'SKILL.md')); } catch (_) { return null; }
    if (!st.isFile()) return null;
    let outros = false;
    try { outros = fs.readdirSync(pasta).some((n) => n !== 'SKILL.md' && !n.startsWith('.')); } catch (_) { outros = false; }
    return { outros, bytes: st.size, modificado_em: new Date(st.mtimeMs).toISOString() };
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
          // Lida a cada pedido: se a pasta skills/ faltava na subida do Web e o atualizar a trouxe, o 503 some sem reiniciar.
          const reservados = nomesReservados();
          if (!reservados.ok) throw new ErroFonte(503, 'A cópia do DG Claw no servidor está sem a pasta skills/; não dá para conferir se o nome é de uma skill da imagem. O dono precisa rodar "dgclaw atualizar".');
          if (reservados.nomes.has(p.nome)) throw new ErroFonte(400, `"${p.nome}" é o nome de uma skill da imagem do DG Claw; uma skill compartilhada com esse nome tomaria o lugar dela. Escolha outro nome (ex.: ${p.nome}-da-empresa).`);
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
          // Uma skill de grupo com o nome de uma global tomaria o lugar dela para o grupo inteiro (a mais específica vence).
          // Nome igual ao de uma skill global: conferido só na hora de gravar (executar), para a resposta ao pedido
          // não servir de oráculo dos nomes das globais (o catálogo dos outros escopos não é do agente).
          const existe = existeSkill(p.grupo, p.nome);
          if (existe && !p.substituir) throw new ErroFonte(409, `Já existe a skill "${p.nome}" no grupo ${p.grupo}. Para trocar o texto, proponha de novo com "substituir": true; a pessoa vai ver que é uma substituição.`);
          if (existe && existe.outros) throw new ErroFonte(409, `A skill "${p.nome}" do grupo ${p.grupo} foi publicada pelo dono com mais arquivos além do SKILL.md; um agente não a substitui. Peça ao dono.`);
          return { nome: p.nome, grupo: p.grupo, conteudo: p.conteudo, substituir: p.substituir === true };
        },
        executar(p, contexto) {
          // Reconfere na hora da aprovação: a pessoa ainda está no grupo? (ela pode ter saído entre pedir e aprovar)
          // Pedido feito pelo dono pela sessão do painel não tem agente na política: o dono publica onde quiser.
          if (papeis && contexto && contexto.agente && !contexto.dono) {
            const e = papeis.estado();
            const ag = e.ok ? e.politica.agentes[contexto.agente] : null;
            const pessoa = ag ? e.politica.pessoas[ag.pessoa] : null;
            if (!pessoa || pessoa.estado === 'desligada' || !pessoa.grupos.includes(p.grupo)) throw new ErroFonte(403, `A pessoa do agente ${contexto.agente} já não faz parte do grupo "${p.grupo}"; a skill não foi gravada.`);
          }
          // Uma global com esse nome seria escondida do grupo pela de grupo (a mais específica vence). O motivo de
          // verdade vai só para o log do Web (do dono); ao agente, a frase genérica.
          if (existeGlobal(p.nome)) {
            if (log) log('aviso', `Skills: a proposta "${p.nome}" para o grupo ${p.grupo} (aprovação ${contexto && contexto.aprovacao}) não foi gravada: já existe uma skill global com esse nome, e a de grupo tomaria o lugar dela para o grupo. Peça outro nome ao agente.`);
            throw new ErroFonte(409, `O nome "${p.nome}" não está disponível para skill de grupo; a skill não foi gravada. Escolha outro nome (ex.: ${p.nome}-${p.grupo}).`);
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
