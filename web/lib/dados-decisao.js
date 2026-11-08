'use strict';
// A decisão de acesso a dados, em uma função pura: recebe a política já carregada (web/lib/papeis.js),
// quem é o agente e o que ele quer, e devolve permitido, negado ou aprovação. Não lê arquivo, não olha o
// conteúdo de dado nenhum e não depende do modelo: texto malicioso num documento não passa por aqui.
//
// Regra: efetivo = pessoa ∩ papel.
//   - leitura (listar, buscar, ler): a pessoa E o papel precisam liberar a fonte com "leitura";
//     os campos são a interseção dos dois (quem não restringe deixa a outra lista valer; os dois sem
//     lista = os campos padrão da fonte). Interseção vazia = negado.
//   - ação: a pessoa E o papel precisam ter a ação como "aprovacao_humana"; o resultado é "aprovacao",
//     e quem executa é uma pessoa no painel. Não existe ação sem aprovação.
//   - política inválida, agente fora do arquivo, pessoa ou papel que sumiram, qualquer exceção: negado.

const OPERACOES_LEITURA = new Set(['listar', 'buscar', 'ler']);
// Consulta por chave sem cair no protótipo: "constructor" ou "__proto__" como nome de agente, fonte ou base
// nunca devolvem algo que não está escrito na política.
const tem = (o, k) => o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const de = (o, k) => (tem(o, k) ? o[k] : undefined);

function intersecao(a, b) {
  if (!a && !b) return null;
  if (!a) return [...b];
  if (!b) return [...a];
  const sb = new Set(b);
  return a.filter((c) => sb.has(c));
}

/**
 * decidir({ estado, slug, fonte, operacao, acao })
 *   estado:   o `estado()` do leitor de papéis ({ ok, erro, politica })
 *   slug:     o agente, vindo da caixa (nunca do corpo do pedido)
 *   fonte:    nome da fonte
 *   operacao: 'listar' | 'buscar' | 'ler' (leitura) ou o nome da operação de ação na fonte
 *   acao:     para operação de ação, o nome da ação nos papéis (ex.: 'enviar_email'); null em leitura
 * Devolve { decisao: 'permitido'|'negado'|'aprovacao', campos: [..]|null, motivo, pessoa, papel }.
 */
function decidir(entrada) {
  try {
    const { estado, slug, fonte, operacao, acao } = entrada || {};
    const negado = (motivo, extra) => Object.assign({ decisao: 'negado', campos: null, motivo, pessoa: null, papel: null }, extra || {});
    if (!estado || !estado.ok) return negado(estado && estado.erro ? estado.erro : 'A política de dados não está carregada; todo acesso está negado.');
    if (typeof slug !== 'string' || !slug) return negado('Pedido sem identidade de agente: a rota de dados só atende pela caixa do agente ou pela sessão do dono.');
    if (typeof fonte !== 'string' || !fonte) return negado('Pedido sem fonte.');
    const pol = estado.politica;
    const ag = de(pol.agentes, slug);
    if (!ag) return negado(`O agente ${slug} não está no arquivo de papéis (/etc/dgclaw/papeis.json); sem pessoa e papel, nenhuma fonte é liberada. Peça ao dono para acrescentá-lo.`);
    const pessoa = de(pol.pessoas, ag.pessoa);
    const papel = de(pol.papeis, ag.papel);
    if (!pessoa) return negado(`A pessoa "${ag.pessoa}" do agente ${slug} não existe mais nos papéis; acesso retirado.`, { pessoa: ag.pessoa, papel: ag.papel });
    if (!papel) return negado(`O papel "${ag.papel}" do agente ${slug} não existe mais nos papéis; acesso retirado.`, { pessoa: ag.pessoa, papel: ag.papel });
    const ids = { pessoa: ag.pessoa, papel: ag.papel };
    if (pessoa.estado === 'desligada') return negado(`A pessoa ${ag.pessoa} está desligada; o agente ${slug} não alcança fonte nem ação alguma.`, ids);

    if (OPERACOES_LEITURA.has(operacao)) {
      const fp = de(pessoa.fontes, fonte);
      const fr = de(papel.fontes, fonte);
      if (!fp || fp.nivel !== 'leitura') return negado(`A pessoa ${ag.pessoa} não tem leitura na fonte "${fonte}"${fp ? ' (está como negado)' : ' (não está escrita)'}; o agente ${slug} não a alcança, qualquer que seja o papel.`, ids);
      if (!fr || fr.nivel !== 'leitura') return negado(`O papel ${ag.papel} não tem leitura na fonte "${fonte}"${fr ? ' (está como negado)' : ' (não está escrita)'}; o agente ${slug} não a alcança.`, ids);
      const campos = intersecao(fp.campos, fr.campos);
      if (campos && !campos.length) return negado(`Os campos de "${fonte}" liberados para a pessoa ${ag.pessoa} e para o papel ${ag.papel} não têm nada em comum; nada pode ser devolvido.`, ids);
      return Object.assign({ decisao: 'permitido', campos, motivo: `leitura de ${fonte} liberada para a pessoa ${ag.pessoa} e para o papel ${ag.papel}` }, ids);
    }

    if (typeof acao !== 'string' || !acao) return negado(`A operação "${String(operacao).slice(0, 40)}" em "${fonte}" não é leitura nem uma ação conhecida.`, ids);
    const ap = de(pessoa.acoes, acao);
    const ar = de(papel.acoes, acao);
    if (ap !== 'aprovacao_humana') return negado(`A pessoa ${ag.pessoa} não tem a ação "${acao}"${ap ? ' (está como negado)' : ' (não está escrita)'}; o agente ${slug} não pode pedi-la.`, ids);
    if (ar !== 'aprovacao_humana') return negado(`O papel ${ag.papel} não tem a ação "${acao}"${ar ? ' (está como negado)' : ' (não está escrita)'}; o agente ${slug} não pode pedi-la.`, ids);
    return Object.assign({ decisao: 'aprovacao', campos: null, motivo: `a ação ${acao} precisa da aprovação de uma pessoa no painel` }, ids);
  } catch (e) {
    return { decisao: 'negado', campos: null, motivo: `Falha interna na decisão de acesso (${e && e.message}); por segurança o pedido foi negado.`, pessoa: null, papel: null };
  }
}

/** A pessoa alcança a base pelo escopo? Devolve null se sim, ou o motivo. */
function foraDoEscopo(nomePessoa, pessoa, base) {
  if (base.escopo === 'empresa' || base.escopo === 'publica') return null;
  if (base.escopo === 'grupo') return pessoa.grupos.includes(base.grupo) ? null : `a base é do grupo "${base.grupo}" e a pessoa ${nomePessoa} não está nele`;
  if (base.escopo === 'privada') return base.pessoa === nomePessoa ? null : `a base é privada de "${base.pessoa}", não de ${nomePessoa}`;
  return `escopo "${base.escopo}" desconhecido`;
}

/** Nível de uma base num bloco "bases": o nome exato vence o "*"; sem nada = null. */
function nivelDaBase(bloco, nome) {
  if (!bloco) return null;
  if (tem(bloco, nome)) return bloco[nome];
  if (tem(bloco, '*')) return bloco['*'];
  return null;
}

/**
 * decidirBase({ estado, slug, base, nomeBase, operacao, acao })
 *   base: a base do catálogo (web/lib/bases.js), já carregada; null se não existe
 * Leitura: pessoa ativa, dentro do escopo da base, sem "negado" no bloco bases da pessoa, e o papel com
 * "leitura" para a base (nome exato ou "*"). Ação (escrever_base): tudo isso E a ação em aprovacao_humana
 * na pessoa e no papel => "aprovacao". O resto é negado.
 */
function decidirBase(entrada) {
  try {
    const { estado, slug, base, nomeBase, operacao, acao } = entrada || {};
    const negado = (motivo, extra) => Object.assign({ decisao: 'negado', campos: null, motivo, pessoa: null, papel: null }, extra || {});
    if (!estado || !estado.ok) return negado(estado && estado.erro ? estado.erro : 'A política de dados não está carregada; todo acesso está negado.');
    if (typeof slug !== 'string' || !slug) return negado('Pedido sem identidade de agente.');
    if (!base || typeof nomeBase !== 'string') return negado(`A base "${String(nomeBase).slice(0, 40)}" não está no catálogo.`);
    const pol = estado.politica;
    const ag = de(pol.agentes, slug);
    if (!ag) return negado(`O agente ${slug} não está no arquivo de papéis; nenhuma base é liberada.`);
    const pessoa = de(pol.pessoas, ag.pessoa);
    const papel = de(pol.papeis, ag.papel);
    const ids = { pessoa: ag.pessoa, papel: ag.papel };
    if (!pessoa) return negado(`A pessoa "${ag.pessoa}" do agente ${slug} não existe mais nos papéis; acesso retirado.`, ids);
    if (!papel) return negado(`O papel "${ag.papel}" do agente ${slug} não existe mais nos papéis; acesso retirado.`, ids);
    if (pessoa.estado === 'desligada') return negado(`A pessoa ${ag.pessoa} está desligada; o agente ${slug} não alcança base nenhuma.`, ids);
    const fora = foraDoEscopo(ag.pessoa, pessoa, base);
    // `invisivel: true` = para o agente a base deve parecer inexistente (404), para não revelar donos de bases privadas
    // nem nomes de grupos; o motivo completo vai só para o log.
    if (fora) return negado(`A base "${nomeBase}" está fora do alcance da pessoa ${ag.pessoa}: ${fora}.`, Object.assign({ invisivel: true }, ids));
    if (nivelDaBase(pessoa.bases, nomeBase) === 'negado') return negado(`A pessoa ${ag.pessoa} tem a base "${nomeBase}" como negada.`, Object.assign({ invisivel: true }, ids));
    const np = nivelDaBase(papel.bases, nomeBase);
    if (np !== 'leitura') return negado(`O papel ${ag.papel} não tem leitura na base "${nomeBase}"${np ? ' (está como negado)' : ' (não está escrita; use o nome ou "*" no bloco "bases" do papel)'}.`, Object.assign({ invisivel: true }, ids));
    if (OPERACOES_LEITURA.has(operacao)) {
      return Object.assign({ decisao: 'permitido', campos: null, motivo: `leitura da base ${nomeBase} (escopo ${base.escopo}) liberada para a pessoa ${ag.pessoa} e para o papel ${ag.papel}`, escopo: base.escopo }, ids);
    }
    if (typeof acao !== 'string' || !acao) return negado(`A operação "${String(operacao).slice(0, 40)}" na base "${nomeBase}" não é leitura nem uma ação conhecida.`, ids);
    if (de(pessoa.acoes, acao) !== 'aprovacao_humana') return negado(`A pessoa ${ag.pessoa} não tem a ação "${acao}"; o agente ${slug} não pode propor escrita na base.`, ids);
    if (de(papel.acoes, acao) !== 'aprovacao_humana') return negado(`O papel ${ag.papel} não tem a ação "${acao}"; o agente ${slug} não pode propor escrita na base.`, ids);
    return Object.assign({ decisao: 'aprovacao', campos: null, motivo: `a ação ${acao} na base ${nomeBase} precisa da aprovação de uma pessoa no painel`, escopo: base.escopo }, ids);
  } catch (e) {
    return { decisao: 'negado', campos: null, motivo: `Falha interna na decisão de acesso (${e && e.message}); por segurança o pedido foi negado.`, pessoa: null, papel: null };
  }
}

module.exports = { decidir, decidirBase, intersecao, foraDoEscopo, nivelDaBase, OPERACOES_LEITURA };
