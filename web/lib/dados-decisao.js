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
    const ag = pol.agentes[slug];
    if (!ag) return negado(`O agente ${slug} não está no arquivo de papéis (/etc/dgclaw/papeis.json); sem pessoa e papel, nenhuma fonte é liberada. Peça ao dono para acrescentá-lo.`);
    const pessoa = pol.pessoas[ag.pessoa];
    const papel = pol.papeis[ag.papel];
    if (!pessoa) return negado(`A pessoa "${ag.pessoa}" do agente ${slug} não existe mais nos papéis; acesso retirado.`, { pessoa: ag.pessoa, papel: ag.papel });
    if (!papel) return negado(`O papel "${ag.papel}" do agente ${slug} não existe mais nos papéis; acesso retirado.`, { pessoa: ag.pessoa, papel: ag.papel });
    const ids = { pessoa: ag.pessoa, papel: ag.papel };

    if (OPERACOES_LEITURA.has(operacao)) {
      const fp = pessoa.fontes[fonte];
      const fr = papel.fontes[fonte];
      if (!fp || fp.nivel !== 'leitura') return negado(`A pessoa ${ag.pessoa} não tem leitura na fonte "${fonte}"${fp ? ' (está como negado)' : ' (não está escrita)'}; o agente ${slug} não a alcança, qualquer que seja o papel.`, ids);
      if (!fr || fr.nivel !== 'leitura') return negado(`O papel ${ag.papel} não tem leitura na fonte "${fonte}"${fr ? ' (está como negado)' : ' (não está escrita)'}; o agente ${slug} não a alcança.`, ids);
      const campos = intersecao(fp.campos, fr.campos);
      if (campos && !campos.length) return negado(`Os campos de "${fonte}" liberados para a pessoa ${ag.pessoa} e para o papel ${ag.papel} não têm nada em comum; nada pode ser devolvido.`, ids);
      return Object.assign({ decisao: 'permitido', campos, motivo: `leitura de ${fonte} liberada para a pessoa ${ag.pessoa} e para o papel ${ag.papel}` }, ids);
    }

    if (typeof acao !== 'string' || !acao) return negado(`A operação "${String(operacao).slice(0, 40)}" em "${fonte}" não é leitura nem uma ação conhecida.`, ids);
    const ap = pessoa.acoes[acao];
    const ar = papel.acoes[acao];
    if (ap !== 'aprovacao_humana') return negado(`A pessoa ${ag.pessoa} não tem a ação "${acao}"${ap ? ' (está como negado)' : ' (não está escrita)'}; o agente ${slug} não pode pedi-la.`, ids);
    if (ar !== 'aprovacao_humana') return negado(`O papel ${ag.papel} não tem a ação "${acao}"${ar ? ' (está como negado)' : ' (não está escrita)'}; o agente ${slug} não pode pedi-la.`, ids);
    return Object.assign({ decisao: 'aprovacao', campos: null, motivo: `a ação ${acao} precisa da aprovação de uma pessoa no painel` }, ids);
  } catch (e) {
    return { decisao: 'negado', campos: null, motivo: `Falha interna na decisão de acesso (${e && e.message}); por segurança o pedido foi negado.`, pessoa: null, papel: null };
  }
}

module.exports = { decidir, intersecao, OPERACOES_LEITURA };
