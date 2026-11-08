'use strict';
// Colaboradores: pessoas convidadas pelo dono para um ou mais agentes de trabalho (docs em web/docs/COLABORADORES.md).
// Guardados em <dataDir>/colaboradores.json (modo 600, gravação atômica). Cada registro tem `agentes` (lista de slugs)
// e `instancias` (slug -> instância do agente no convite); registros antigos, com `agente`/`instancia` no singular,
// são lidos e convertidos em memória (os campos antigos continuam gravados, espelhando o primeiro agente).
// Quem grava é o Web (fila em memória) ou a CLI (web/lib/colaboradores-cli.js), nunca os dois ao mesmo tempo: a
// gravação toma a trava `colaboradores.json.trava` (mkdir), a mesma da CLI, e o Web relê o arquivo quando o mtime
// muda. Revogar é datar (revogado_em), nunca apagar o registro. O hash da senha nunca sai daqui para a API: use publico().

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VALIDADE_TEMPORARIA_MS = 7 * 24 * 60 * 60 * 1000;
// Sem 0, O, 1, I, l: a pessoa digita a senha temporária lendo de um e-mail ou de uma mensagem.
const ALFABETO_SENHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const TAMANHO_SENHA = 12;
const RX_EMAIL = /^[^\s@<>"',;:()[\]\\]+@[^\s@<>"',;:()[\]\\]+\.[^\s@<>"',;:()[\]\\]+$/;

function erroStatus(status, mensagem, extra) {
  const e = new Error(mensagem);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

/** E-mail minúsculo e validado, ou lança erro 400 que diz o que está errado. */
function normalizaEmail(bruto) {
  const e = typeof bruto === 'string' ? bruto.trim().toLowerCase() : '';
  if (!e) throw erroStatus(400, 'Informe o e-mail do colaborador no campo "email".');
  if (/[\r\n]/.test(e)) throw erroStatus(400, 'O e-mail não pode ter quebra de linha.');
  if (e.length > 254) throw erroStatus(400, `O e-mail tem ${e.length} caracteres e o limite é 254.`);
  if (!RX_EMAIL.test(e)) throw erroStatus(400, `"${e.slice(0, 80)}" não parece um e-mail válido. Use o formato nome@dominio.com.`);
  return e;
}

/** Nome opcional (até 80, sem quebra de linha nem < >). Devolve '' quando não veio. */
function normalizaNome(bruto) {
  if (bruto == null || bruto === '') return '';
  if (typeof bruto !== 'string') throw erroStatus(400, 'O campo "nome" precisa ser um texto.');
  const n = bruto.trim();
  if (/[\r\n<>]/.test(n)) throw erroStatus(400, 'O nome não pode ter quebra de linha nem os sinais < e >.');
  if (n.length > 80) throw erroStatus(400, `O nome tem ${n.length} caracteres e o limite é 80.`);
  return n;
}

/** Lista de slugs válida (1 a 50, únicos, no formato de slug) ou erro 400 que diz o que está errado. */
function normalizaAgentes(bruto) {
  const lista = Array.isArray(bruto) ? bruto : (typeof bruto === 'string' && bruto ? [bruto] : []);
  if (!lista.length) throw erroStatus(400, 'Diga para quais agentes é o acesso, no campo "agentes" (lista de slugs; veja GET /api/v1/agents).');
  if (lista.length > 50) throw erroStatus(400, `São ${lista.length} agentes na lista e o limite é 50.`);
  const vistos = [];
  for (const a of lista) {
    if (typeof a !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(a)) throw erroStatus(400, `"${String(a).slice(0, 40)}" não é um slug de agente válido (letras minúsculas, números e hífen).`);
    if (!vistos.includes(a)) vistos.push(a);
  }
  return vistos;
}

/** Registro antigo (agente/instancia no singular) vira o formato novo, em memória. */
function normalizaRegistro(c) {
  if (!Array.isArray(c.agentes) || !c.agentes.length) c.agentes = typeof c.agente === 'string' && c.agente ? [c.agente] : [];
  c.agentes = c.agentes.filter((a) => typeof a === 'string' && a);
  if (!c.instancias || typeof c.instancias !== 'object' || Array.isArray(c.instancias)) c.instancias = {};
  if (typeof c.instancia === 'string' && c.instancia && c.agentes[0] && !c.instancias[c.agentes[0]]) c.instancias[c.agentes[0]] = c.instancia;
  espelhaSingular(c);
  return c;
}
/** Os campos antigos (`agente`, `instancia`) espelham o primeiro agente, para quem ainda lê o formato antigo. */
function espelhaSingular(c) {
  c.agente = c.agentes[0] || '';
  c.instancia = c.agentes[0] ? (c.instancias[c.agentes[0]] || null) : null;
}

const marcaDe = (st) => `${st.ino}:${st.mtimeMs}:${st.size}`;

const TRAVA_ESPERA_MS = 2000;
const TRAVA_VELHA_MS = 10000;
/**
 * Trava compartilhada com a CLI (mkdir é atômico no mesmo disco). Espera até 2 s; trava com mais de 10 s é considerada
 * órfã (processo que morreu) e é removida. Síncrona porque grava() é síncrona e roda dentro da fila.
 */
function comTrava(arquivo, fn) {
  const trava = `${arquivo}.trava`;
  const inicio = Date.now();
  for (;;) {
    try { fs.mkdirSync(trava); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Trava órfã: renomear antes de apagar, porque o rename é atômico e só um dos processos que a acharam velha ganha;
      // o outro vê ENOENT e volta ao mkdir, em vez de apagar a trava nova de quem ganhou.
      try {
        if (Date.now() - fs.statSync(trava).mtimeMs > TRAVA_VELHA_MS) {
          const velha = `${trava}.velha.${process.pid}.${crypto.randomBytes(3).toString('hex')}`;
          fs.renameSync(trava, velha); fs.rmdirSync(velha); continue;
        }
      } catch (_) { /* sumiu ou outro processo a levou entre o stat e o rename: tenta de novo */ }
      if (Date.now() - inicio > TRAVA_ESPERA_MS) throw erroStatus(503, 'Outra gravação na lista de colaboradores está em andamento (a CLI, provavelmente). Tente de novo em alguns segundos.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(trava); } catch (_) { /* já saiu */ } }
}

function geraSenhaTemporaria() {
  let s = '';
  for (let i = 0; i < TAMANHO_SENHA; i++) s += ALFABETO_SENHA[crypto.randomInt(ALFABETO_SENHA.length)];
  return s;
}

/**
 * config: { dataDir }; log; agora (relógio injetável); gerarHash(senha) -> Promise<string> (o do auth.js).
 */
function criarColaboradores({ config, log, agora, gerarHash }) {
  const relogio = agora || (() => Date.now());
  const arquivo = path.join(config.dataDir, 'colaboradores.json');
  let lista = [];
  let raizAlheia = {};     // chaves do arquivo que não são nossas (comentario...): sobrevivem à gravação
  let mtimeVisto = -1;     // -1: ainda não li; 0: arquivo ausente
  let marcaVista = 'nunca';  // inode:mtime:tamanho do arquivo que a lista em memória reflete (grava() confere sob a trava)
  let ilegivel = null;     // motivo, quando o arquivo existe e não deu para ler
  let fila = Promise.resolve();

  /** Relê do disco quando o mtime mudou (alguém pode ter editado à mão). Nunca apaga nem sobrescreve. */
  function carrega() {
    let st;
    try { st = fs.statSync(arquivo); } catch (e) {
      if (e.code === 'ENOENT') { lista = []; ilegivel = null; mtimeVisto = 0; marcaVista = 'ausente'; return; }
      if (mtimeVisto !== -2) log('erro', `Não consegui acessar ${arquivo} (${e.code || e.message}). Trato como "nenhum colaborador" e não gravo nada até o arquivo voltar a abrir; confira a permissão de ${config.dataDir}.`);
      lista = []; ilegivel = `${e.code || e.message}`; mtimeVisto = -2;
      return;
    }
    const marca = st.mtimeMs;
    marcaVista = marcaDe(st);
    if (marca === mtimeVisto) return;
    try {
      const j = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
      if (!j || typeof j !== 'object' || !Array.isArray(j.colaboradores)) throw new Error('o conteúdo não tem a lista "colaboradores"');
      raizAlheia = Object.fromEntries(Object.entries(j).filter(([k]) => k !== 'colaboradores' && k !== 'versao'));
      lista = j.colaboradores.filter((c) => c && typeof c === 'object' && typeof c.id === 'string' && typeof c.email === 'string' && (typeof c.agente === 'string' || Array.isArray(c.agentes))).map(normalizaRegistro);
      if (lista.length !== j.colaboradores.length) log('aviso', `Em ${arquivo}, ${j.colaboradores.length - lista.length} registro(s) sem id, e-mail ou agente foram ignorados (o arquivo não foi alterado).`);
      ilegivel = null;
    } catch (e) {
      lista = [];
      ilegivel = e.message;
      log('erro', `O arquivo ${arquivo} está ilegível (${e.message}). Trato como "nenhum colaborador" e NÃO apaguei nem vou regravar o arquivo. Corrija o JSON (ou renomeie o arquivo para recomeçar) e tente de novo.`);
    }
    mtimeVisto = marca;
  }

  function grava() {
    const tmp = `${arquivo}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(path.dirname(arquivo), { recursive: true, mode: 0o700 });
      for (const c of lista) espelhaSingular(c);
      comTrava(arquivo, () => {
        // A trava cobre só este trecho; a leitura e o scrypt ficaram fora dela. Se o arquivo mudou desde a leitura que
        // a lista em memória reflete (a CLI, o painel em outro processo, edição à mão), gravar agora apagaria essa
        // mudança: recusa, e a próxima leitura recarrega. Quem chamou desfaz a alteração em memória.
        let agora = 'ausente';
        try { agora = marcaDe(fs.statSync(arquivo)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (agora !== marcaVista) {
          mtimeVisto = -1;
          throw erroStatus(409, 'A lista de colaboradores mudou enquanto a sua alteração era preparada (o painel ou a CLI gravou). Tente de novo.');
        }
        fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, raizAlheia, { versao: 1, colaboradores: lista }), null, 2) + '\n', { mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, arquivo);
        const st = fs.statSync(arquivo);
        mtimeVisto = st.mtimeMs; marcaVista = marcaDe(st);
      });
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* o temporário nem chegou a existir */ }
      if (e && (e.status === 503 || e.status === 409)) throw e;
      log('erro', `Não consegui gravar ${arquivo} (${e.code || e.message}). Confira o espaço em disco e a permissão de ${config.dataDir}.`);
      throw erroStatus(500, `Não consegui gravar a lista de colaboradores (${e.code || e.message}). Confira o espaço em disco e a permissão da pasta de dados do Web.`);
    }
  }

  /** Roda fn em fila (uma por vez), com o arquivo recém-lido. Se o arquivo está ilegível, recusa em vez de sobrescrevê-lo. */
  function transacao(fn) {
    const p = fila.then(async () => {
      carrega();
      if (ilegivel) throw erroStatus(500, `O arquivo ${arquivo} está ilegível (${ilegivel}), então não gravo nada para não perder o que está nele. Corrija o JSON ou renomeie o arquivo para recomeçar.`);
      return fn();
    });
    fila = p.catch(() => undefined);
    return p;
  }

  function estadoDe(c) {
    if (c.revogado_em) return 'revogado';
    if (c.trocar_senha) return Number(c.temporaria_expira) < relogio() ? 'temporaria_vencida' : 'aguardando_primeiro_acesso';
    return 'ativo';
  }

  /** O registro sem o hash, com o estado calculado. */
  function publico(c) {
    return {
      id: c.id, email: c.email, nome: c.nome || '', agentes: c.agentes.slice(), agente: c.agentes[0] || '', estado: estadoDe(c),
      trocar_senha: !!c.trocar_senha, temporaria_expira: c.trocar_senha ? c.temporaria_expira : null,
      criado_em: c.criado_em, criado_por: c.criado_por, revogado_em: c.revogado_em || null, ultimo_login: c.ultimo_login || null,
    };
  }

  const ativos = () => { carrega(); return lista.filter((c) => !c.revogado_em); };

  return {
    arquivo,
    VALIDADE_TEMPORARIA_MS,
    publico,
    estadoDe,
    normalizaEmail,
    normalizaAgentes,

    /** Todos (inclusive os revogados), do mais novo para o mais antigo; `agente` filtra pelos que o têm na lista. */
    lista(agente) {
      carrega();
      return lista.filter((c) => !agente || c.agentes.includes(agente)).slice().sort((a, b) => b.criado_em - a.criado_em).map(publico);
    },
    obter(id) { carrega(); return lista.find((c) => c.id === id) || null; },
    porEmailAtivo(email) {
      const e = String(email || '').trim().toLowerCase();
      return e ? ativos().find((c) => c.email === e) || null : null;
    },
    /** O primeiro colaborador ativo do agente (compatibilidade); prefira ativosDoAgente. */
    ativoDoAgente(slug) { return ativos().find((c) => c.agentes.includes(slug)) || null; },
    /** Todos os colaboradores ativos que alcançam o agente. */
    ativosDoAgente(slug) { return ativos().filter((c) => c.agentes.includes(slug)); },

    /**
     * Cria o convite para um ou mais agentes. As regras que dependem do registro de agentes (existe? é o Admin?) ficam
     * na rota; `instancias` é { slug: instância } e precisa cobrir todos os agentes.
     */
    criar({ agentes, agente, email, nome, criadoPor, instancias }) {
      return transacao(async () => {
        const slugs = normalizaAgentes(agentes || agente);
        const inst = instancias && typeof instancias === 'object' ? instancias : {};
        for (const slug of slugs) if (!inst[slug]) throw erroStatus(500, `Não consegui identificar esta instância do agente ${slug} (casa ausente ou ilegível), e o convite precisa dela para não valer num agente recriado com o mesmo nome. Rode "dgclaw agente reparar ${slug}" e confira o log do Web.`);
        const mail = normalizaEmail(email);
        const nomeOk = normalizaNome(nome);
        const doEmail = lista.find((c) => !c.revogado_em && c.email === mail);
        if (doEmail) throw erroStatus(409, `O e-mail ${mail} já é colaborador (agente${doEmail.agentes.length > 1 ? 's' : ''} ${doEmail.agentes.join(', ')}). Para dar acesso a mais um agente, altere os agentes dele em vez de convidar de novo.`);
        const senha = geraSenhaTemporaria();
        const hash = await gerarHash(senha);
        const t = relogio();
        const registro = normalizaRegistro({
          id: crypto.randomBytes(16).toString('base64url'), email: mail, nome: nomeOk, agentes: slugs, instancias: Object.fromEntries(slugs.map((x) => [x, inst[x]])), hash,
          trocar_senha: true, temporaria_expira: t + VALIDADE_TEMPORARIA_MS, senha_versao: 1,
          criado_em: t, criado_por: criadoPor || null, revogado_em: null, ultimo_login: null,
        });
        lista.push(registro);
        try { grava(); } catch (e) { lista.pop(); throw e; }
        return { registro: publico(registro), senha };
      });
    },

    /**
     * Muda os agentes (lista completa, substitui a anterior) e/ou o nome de um colaborador ativo. A sessão dele não cai:
     * o pedido seguinte já enxerga a lista nova (ver auth.sessaoDeColaborador). `instancias` cobre os agentes novos.
     */
    alterar(id, campos, instancias) {
      return transacao(async () => {
        const c = lista.find((x) => x.id === id);
        if (!c) throw erroStatus(404, `Não existe colaborador com o id "${String(id).slice(0, 40)}". Veja GET /api/v1/colaboradores.`);
        if (c.revogado_em) throw erroStatus(409, `O acesso de ${c.email} já foi revogado. Convide a pessoa de novo para ela voltar a entrar.`);
        const f = campos && typeof campos === 'object' ? campos : {};
        if (f.agentes === undefined && f.nome === undefined) throw erroStatus(400, 'Mande ao menos um de: "agentes" (lista de slugs) ou "nome".');
        const antes = Object.assign({}, c, { agentes: c.agentes.slice(), instancias: Object.assign({}, c.instancias) });
        if (f.agentes !== undefined) {
          const slugs = normalizaAgentes(f.agentes);
          const inst = instancias && typeof instancias === 'object' ? instancias : {};
          const novas = {};
          for (const slug of slugs) {
            const i = inst[slug] || c.instancias[slug];
            if (!i) throw erroStatus(500, `Não consegui identificar esta instância do agente ${slug} (casa ausente ou ilegível). Rode "dgclaw agente reparar ${slug}" e confira o log do Web.`);
            novas[slug] = i;
          }
          c.agentes = slugs; c.instancias = novas;
        }
        if (f.nome !== undefined) c.nome = normalizaNome(f.nome);
        espelhaSingular(c);
        try { grava(); } catch (e) { Object.assign(c, antes); throw e; }
        return publico(c);
      });
    },

    /** Senha temporária nova: derruba as sessões (senha_versao sobe) e exige a troca no próximo acesso. */
    reenviar(id) {
      return transacao(async () => {
        const c = lista.find((x) => x.id === id);
        if (!c) throw erroStatus(404, `Não existe colaborador com o id "${String(id).slice(0, 40)}". Veja GET /api/v1/colaboradores.`);
        if (c.revogado_em) throw erroStatus(409, `O acesso de ${c.email} já foi revogado. Convide a pessoa de novo para ela voltar a entrar.`);
        const senha = geraSenhaTemporaria();
        const hash = await gerarHash(senha);
        const antes = Object.assign({}, c);
        Object.assign(c, { hash, trocar_senha: true, temporaria_expira: relogio() + VALIDADE_TEMPORARIA_MS, senha_versao: (c.senha_versao || 1) + 1 });
        try { grava(); } catch (e) { Object.assign(c, antes); throw e; }
        return { registro: publico(c), senha };
      });
    },

    /**
     * Tira o agente `slug` dos convites ativos que o guardaram com outra instância (o agente foi removido e recriado
     * com o mesmo nome); um registro que fica sem agente é revogado. Devolve quantos registros mudaram. Chamado antes
     * de convidar de novo e quando o Web nota a troca.
     */
    revogarDeOutraInstancia(slug, instanciaAtual) {
      return transacao(async () => {
        let n = 0;
        const t = relogio();
        const desfazer = [];
        for (const c of lista) {
          if (c.revogado_em || !c.agentes.includes(slug)) continue;
          if (c.instancias[slug] && c.instancias[slug] === instanciaAtual) continue;
          desfazer.push([c, c.agentes.slice(), Object.assign({}, c.instancias)]);
          c.agentes = c.agentes.filter((a) => a !== slug); delete c.instancias[slug];
          if (!c.agentes.length) c.revogado_em = t;
          espelhaSingular(c);
          n += 1;
        }
        if (n) {
          try { grava(); } catch (e) { for (const [c, ags, inst] of desfazer) { c.agentes = ags; c.instancias = inst; if (c.revogado_em === t) c.revogado_em = null; espelhaSingular(c); } throw e; }
        }
        return n;
      });
    },

    revogar(id) {
      return transacao(async () => {
        const c = lista.find((x) => x.id === id);
        if (!c) throw erroStatus(404, `Não existe colaborador com o id "${String(id).slice(0, 40)}". Veja GET /api/v1/colaboradores.`);
        if (c.revogado_em) throw erroStatus(409, `O acesso de ${c.email} já foi revogado em ${new Date(c.revogado_em).toISOString()}. Nada a fazer.`);
        c.revogado_em = relogio();
        try { grava(); } catch (e) { c.revogado_em = null; throw e; }
        return publico(c);
      });
    },

    /** O próprio colaborador escolhe a senha: hash novo, fim da temporária, senha_versao sobe. */
    definirSenha(id, hash, esperado) {
      return transacao(async () => {
        const c = lista.find((x) => x.id === id);
        if (!c || c.revogado_em) throw erroStatus(401, 'Seu acesso não vale mais. Peça ao dono do DG Claw um convite novo.');
        // A conferência e a gravação acontecem juntas, na fila: se o dono reenviou o convite (ou a senha mudou por
        // outro caminho) depois que este pedido começou, a troca velha não pode passar por cima.
        if (esperado && ((c.senha_versao || 1) !== esperado.versao || c.hash !== esperado.hash || (esperado.trocar_senha !== undefined && !!c.trocar_senha !== esperado.trocar_senha))) {
          throw erroStatus(409, 'Sua senha ou seu convite mudou enquanto você trocava a senha (o dono pode ter mandado um convite novo). Entre de novo com a senha mais recente.');
        }
        if (c.trocar_senha && Number(c.temporaria_expira) < relogio()) throw erroStatus(401, 'A senha temporária venceu. Peça ao dono do DG Claw um convite novo.');
        const antes = Object.assign({}, c);
        Object.assign(c, { hash, trocar_senha: false, temporaria_expira: null, senha_versao: (c.senha_versao || 1) + 1 });
        try { grava(); } catch (e) { Object.assign(c, antes); throw e; }
        return { registro: publico(c), senha_versao: c.senha_versao };
      });
    },

    registrarLogin(id) {
      return transacao(async () => {
        const c = lista.find((x) => x.id === id);
        if (!c) return;
        c.ultimo_login = relogio();
        try { grava(); } catch (e) { log('aviso', `Não consegui registrar o último acesso de ${c.email} (${e.message}).`); }
      }).catch((e) => { log('aviso', `Não registrei o último acesso: ${e.message}`); });
    },
  };
}

module.exports = { criarColaboradores, normalizaEmail, normalizaNome, normalizaAgentes, geraSenhaTemporaria, VALIDADE_TEMPORARIA_MS };
