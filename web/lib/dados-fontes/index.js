'use strict';
// Catálogo das fontes de dados que a rota /api/v1/dados alcança. Cada fonte é um adaptador com a mesma
// interface mínima; o filtro de campos e a decisão de acesso ficam FORA dele (em dados.js e
// dados-decisao.js), para que nenhum adaptador tenha como ampliar o que o agente recebe.
//
// Interface de um adaptador:
//   nome            'agenda'
//   catalogo        { dono, classificacao, finalidade, retencao_dias }   (o catálogo da fonte, só informativo)
//   campos          ['id', 'nome', ...]   os campos que existem; `campos` null na decisão = todos estes
//   operacoes       { listar({ limit }), buscar({ termo, limit }), ler({ id }) } -> { itens: [..] } | { item }
//                   cada uma lança ErroFonte(status, mensagem) quando a entrada é inválida
//   acoes           { <operacao>: { acao: 'enviar_email', validar(params) -> params limpos, executar(params) -> resultado } }
//
// Dados locais e fictícios: cada fonte JSON lê <dir>/<nome>.json ({ "itens": [ {...} ] }); sem o arquivo, a
// lista é vazia. Nenhum sistema real entra por aqui nesta versão (web/docs/DADOS-POR-PAPEL.md).

const { fonteJson, ErroFonte } = require('./json');
const { fontePasta } = require('./pasta');
const { fonteEmail } = require('./email');
const { fonteBase } = require('./base');

const RX_BASE = /^base-([a-z][a-z0-9_-]{0,39})$/;

/**
 * `bases` (opcional): o leitor de web/lib/bases.js e a pasta das bases. Cada base do catálogo vira a fonte
 * dinâmica "base-<nome>", lida da pasta <basesDir>/<nome>/. Base fora do catálogo não é fonte.
 */
function criarFontes({ dir, log, agora, bases, basesDir }) {
  const lista = [
    fonteJson({ dir, nome: 'agenda', campos: ['id', 'data', 'hora', 'titulo', 'com', 'local'], busca: ['titulo', 'com', 'local'],
      catalogo: { dono: 'secretaria', classificacao: 'interno', finalidade: 'marcar e consultar compromissos', retencao_dias: 365 } }),
    fonteJson({ dir, nome: 'clientes', campos: ['id', 'nome', 'telefone', 'email', 'cpf', 'saldo'], busca: ['nome', 'email', 'telefone'],
      catalogo: { dono: 'comercial', classificacao: 'pessoal', finalidade: 'atendimento e contato', retencao_dias: 1825 } }),
    fonteJson({ dir, nome: 'folha', campos: ['id', 'nome', 'cargo', 'salario', 'admissao'], busca: ['nome', 'cargo'],
      catalogo: { dono: 'rh', classificacao: 'sensivel', finalidade: 'folha de pagamento', retencao_dias: 1825 } }),
    fontePasta({ dir, nome: 'pasta', log,
      catalogo: { dono: 'administrativo', classificacao: 'interno', finalidade: 'documentos de trabalho em texto', retencao_dias: 0 } }),
    fonteEmail({ dir, nome: 'email', agora,
      catalogo: { dono: 'comunicacao', classificacao: 'interno', finalidade: 'envio de e-mail em nome da pessoa (simulado nesta versão)', retencao_dias: 90 } }),
  ];
  const mapa = new Map(lista.map((f) => [f.nome, f]));
  const descreve = (f) => ({ nome: f.nome, base: f.base || null, campos: f.campos, operacoes: Object.keys(f.operacoes), acoes: Object.fromEntries(Object.entries(f.acoes || {}).map(([op, a]) => [op, a.acao])), catalogo: f.catalogo });

  function daBase(nomeBase) {
    if (!bases || !basesDir) return null;
    const b = bases.obter(nomeBase);
    if (!b) return null;
    return fonteBase({ dir: basesDir, nome: nomeBase, base: b, log, catalogo: { dono: b.dono, classificacao: b.classificacao, finalidade: b.finalidade, retencao_dias: b.retencao_dias, escopo: b.escopo, grupo: b.grupo, pessoa: b.pessoa, titulo: b.nome } });
  }

  return {
    obter(nome) {
      const fixa = mapa.get(nome);
      if (fixa) return fixa;
      const m = RX_BASE.exec(String(nome));
      return m ? daBase(m[1]) : null;
    },
    nomes() { return [...mapa.keys(), ...(bases && bases.estado().ok ? Object.keys(bases.estado().bases).map((n) => `base-${n}`) : [])]; },
    /** Para o dono e para a documentação: o catálogo de cada fonte (fixas e bases), sem dado nenhum. */
    catalogo() {
      const fixas = lista.map(descreve);
      const est = bases ? bases.estado() : null;
      const dinamicas = est && est.ok ? Object.keys(est.bases).sort().map((n) => descreve(daBase(n))) : [];
      return fixas.concat(dinamicas);
    },
  };
}

module.exports = { criarFontes, ErroFonte };
