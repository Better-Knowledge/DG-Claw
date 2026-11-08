'use strict';
// Ponte entre a CLI (lib/colaboradores.sh, `dgclaw colaborador ...`) e web/lib/colaboradores.js: a mesma regra, o mesmo
// arquivo, a mesma trava (colaboradores.json.trava). O Web relê o arquivo quando o mtime muda, então revogar ou
// reenviar por aqui derruba a sessão da pessoa no pedido seguinte, como pela tela.
// Uso: node colaboradores-cli.js <dataDir|-> <web.env> <agentes.json|-> <acao> [json]
//   "-" em dataDir ou agentes.json = o que o web.env diz (DGCLAW_WEB_DATA, DGCLAW_AGENTES), lido pelo MESMO parser do
//   Web (web/lib/config.js), senão o padrão; assim a CLI nunca grava onde o Web não lê.
//   acoes: listar | convidar {email, nome?, agentes} | agentes {email, agentes} | nome {email, nome} | reenviar {email} | revogar {email}
// Saída: JSON em stdout; erro em stderr com código 1. Nunca imprime hash de senha; a senha temporária sai UMA vez, no
// convite e no reenvio, para a pessoa que opera a CLI repassar.

const fs = require('node:fs');
const { criarColaboradores } = require('./colaboradores');
const { criarRegistro } = require('./registro');
const { lerEnvArquivo } = require('./config');
const { gerarHashSenha } = require('./auth');
const { instanciaDe } = require('./instancia');

function sai(status, msg) { process.stderr.write(`${msg}\n`); process.exit(status); }

async function main() {
  const [dataDirArg, webEnv, agentesArg, acao, bruto] = process.argv.slice(2);
  if (!dataDirArg || !webEnv || !agentesArg || !acao) sai(2, 'uso: colaboradores-cli.js <dataDir|-> <web.env> <agentes.json|-> <acao> [json]');
  const log = (nivel, msg) => { if (nivel !== 'info') process.stderr.write(`[${nivel}] ${msg}\n`); };
  const env = lerEnvArquivo(webEnv).vars || {};
  const raiz = process.env.DGCLAW_RAIZ || '';
  const dataDir = dataDirArg !== '-' ? dataDirArg : (env.DGCLAW_WEB_DATA || `${raiz}/var/lib/dgclaw/web`);
  const agentesPath = agentesArg !== '-' ? agentesArg : (env.DGCLAW_AGENTES || `${raiz}/etc/dgclaw/agentes.json`);
  try { fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); } catch (e) { sai(1, `não consegui criar ${dataDir} (${e.code || e.message})`); }
  const colaboradores = criarColaboradores({ config: { dataDir }, log, gerarHash: gerarHashSenha });
  const registro = criarRegistro({ caminho: agentesPath, log });
  let dados = {};
  if (bruto) { try { dados = JSON.parse(bruto); } catch (e) { sai(2, `JSON inválido: ${e.message}`); } }

  /** Valida a lista de agentes como a rota do Web: existe, não é o Admin, tem instância; tira instâncias recriadas dos convites antigos. */
  async function agentesDoPedido(bruto) {
    const slugs = colaboradores.normalizaAgentes(bruto);
    const est = registro.estado();
    if (!est.ok) throw Object.assign(new Error(est.erro), { status: 503 });
    const instancias = {};
    const nomes = [];
    for (const slug of slugs) {
      const ag = registro.obter(slug);
      if (!ag) throw Object.assign(new Error(`não existe agente "${slug}". Veja: dgclaw agente listar`), { status: 404 });
      if (ag.tipo === 'admin') throw Object.assign(new Error('o Admin nunca pode ser compartilhado: ele mexe no servidor inteiro. Convide para um agente de trabalho.'), { status: 400 });
      const inst = instanciaDe(ag);
      if (!inst) throw Object.assign(new Error(`não consegui identificar a instância do agente ${slug} (casa ausente ou ilegível). Rode: dgclaw agente reparar ${slug}`), { status: 500 });
      instancias[slug] = inst; nomes.push(ag.nome || slug);
    }
    for (const slug of slugs) await colaboradores.revogarDeOutraInstancia(slug, instancias[slug]);
    return { slugs, instancias, nomes };
  }
  const ativoOuErro = (email) => {
    const mail = colaboradores.normalizaEmail(email);
    const c = colaboradores.porEmailAtivo(mail);
    if (!c) throw Object.assign(new Error(`${mail} não é colaborador ativo. Veja: dgclaw colaborador listar`), { status: 404 });
    return c;
  };
  const nomesDe = (slugs) => slugs.map((s) => { const a = registro.obter(s); return a ? a.nome : s; });

  try {
    let r;
    if (acao === 'listar') r = { ok: true, colaboradores: colaboradores.lista().map((c) => Object.assign({}, c, { agentes_nomes: nomesDe(c.agentes) })) };
    else if (acao === 'convidar') {
      const mail = colaboradores.normalizaEmail(dados.email);
      if (mail === String(env.DGCLAW_PANEL_USER || '').trim().toLowerCase()) throw Object.assign(new Error('esse e-mail é o do próprio dono do DG Claw (o usuário do login). Informe o e-mail do colaborador.'), { status: 400 });
      const alvo = await agentesDoPedido(dados.agentes);
      const c = await colaboradores.criar({ agentes: alvo.slugs, email: mail, nome: dados.nome, criadoPor: 'cli', instancias: alvo.instancias });
      r = { ok: true, colaborador: c.registro, agentes_nomes: alvo.nomes, senha_temporaria: c.senha, expira: new Date(c.registro.temporaria_expira).toISOString() };
    } else if (acao === 'agentes') {
      const c = ativoOuErro(dados.email);
      const alvo = await agentesDoPedido(dados.agentes);
      r = { ok: true, colaborador: await colaboradores.alterar(c.id, { agentes: alvo.slugs }, alvo.instancias), agentes_nomes: alvo.nomes };
    } else if (acao === 'nome') {
      const c = ativoOuErro(dados.email);
      r = { ok: true, colaborador: await colaboradores.alterar(c.id, { nome: dados.nome }, {}) };
    } else if (acao === 'reenviar') {
      const c = ativoOuErro(dados.email);
      const re = await colaboradores.reenviar(c.id);
      r = { ok: true, colaborador: re.registro, agentes_nomes: nomesDe(re.registro.agentes), senha_temporaria: re.senha, expira: new Date(re.registro.temporaria_expira).toISOString() };
    } else if (acao === 'revogar') {
      const c = ativoOuErro(dados.email);
      r = { ok: true, colaborador: await colaboradores.revogar(c.id) };
    } else sai(2, `ação desconhecida: ${acao}`);
    process.stdout.write(JSON.stringify(r) + '\n');
  } catch (e) {
    sai(1, (e && e.message) || String(e));
  }
}

main();
