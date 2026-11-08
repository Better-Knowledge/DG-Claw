'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decidir, intersecao } = require('../lib/dados-decisao');
const { validaPapeis } = require('../lib/papeis');

const POLITICA = validaPapeis({
  versao: 1,
  pessoas: {
    marta: { fontes: { agenda: 'leitura', clientes: { nivel: 'leitura', campos: ['nome', 'telefone', 'email'] }, folha: 'leitura' }, acoes: { enviar_email: 'aprovacao_humana' } },
    caio: { fontes: { agenda: 'leitura', clientes: { nivel: 'leitura', campos: ['email'] } }, acoes: {} },
    lia: { fontes: { clientes: 'leitura' } },
  },
  papeis: {
    recepcao: { fontes: { agenda: 'leitura', clientes: { nivel: 'leitura', campos: ['nome', 'telefone'] }, folha: 'negado' }, acoes: { enviar_email: 'aprovacao_humana', apagar_arquivo: 'negado' } },
    analista: { fontes: { agenda: 'leitura', folha: 'leitura', clientes: 'leitura' }, acoes: { enviar_email: 'aprovacao_humana' } },
  },
  agentes: { ana: { pessoa: 'marta', papel: 'recepcao' }, bia: { pessoa: 'caio', papel: 'analista' }, duda: { pessoa: 'lia', papel: 'recepcao' } },
}).politica;
const ESTADO = { ok: true, erro: null, politica: POLITICA };

test('interseção de campos: sem lista de um lado vale a do outro; dos dois, só o comum', () => {
  assert.equal(intersecao(null, null), null);
  assert.deepEqual(intersecao(null, ['a', 'b']), ['a', 'b']);
  assert.deepEqual(intersecao(['a', 'b'], null), ['a', 'b']);
  assert.deepEqual(intersecao(['nome', 'telefone', 'email'], ['nome', 'telefone']), ['nome', 'telefone']);
  assert.deepEqual(intersecao(['x'], ['y']), []);
});

test('leitura: pessoa e papel liberam, campos pela interseção', () => {
  const r = decidir({ estado: ESTADO, slug: 'ana', fonte: 'clientes', operacao: 'listar' });
  assert.equal(r.decisao, 'permitido');
  assert.deepEqual(r.campos, ['nome', 'telefone']);
  assert.equal(r.pessoa, 'marta'); assert.equal(r.papel, 'recepcao');
  // sem lista nos dois lados: campos null (os padrão da fonte)
  assert.equal(decidir({ estado: ESTADO, slug: 'ana', fonte: 'agenda', operacao: 'buscar' }).campos, null);
  // lista só de um lado
  assert.deepEqual(decidir({ estado: ESTADO, slug: 'duda', fonte: 'clientes', operacao: 'ler' }).campos, ['nome', 'telefone']);
});

test('negar por padrão: analista não lê a folha quando a PESSOA não libera, e recepção não lê quando o PAPEL nega', () => {
  // bia: papel analista libera folha, mas a pessoa caio não a cita => negado (interseção)
  let r = decidir({ estado: ESTADO, slug: 'bia', fonte: 'folha', operacao: 'listar' });
  assert.equal(r.decisao, 'negado'); assert.match(r.motivo, /pessoa caio não tem leitura na fonte "folha" \(não está escrita\)/);
  // ana: pessoa marta libera folha, mas o papel recepcao nega explicitamente
  r = decidir({ estado: ESTADO, slug: 'ana', fonte: 'folha', operacao: 'listar' });
  assert.equal(r.decisao, 'negado'); assert.match(r.motivo, /papel recepcao não tem leitura na fonte "folha" \(está como negado\)/);
  // fonte que ninguém escreveu
  r = decidir({ estado: ESTADO, slug: 'ana', fonte: 'segredos', operacao: 'ler' });
  assert.equal(r.decisao, 'negado'); assert.match(r.motivo, /não está escrita/);
});

test('interseção vazia de campos é negado, não "tudo"', () => {
  // caio só email; recepcao só nome e telefone => nada em comum
  const r = decidir({ estado: { ok: true, politica: Object.assign({}, POLITICA, { agentes: { x: { pessoa: 'caio', papel: 'recepcao' } } }) }, slug: 'x', fonte: 'clientes', operacao: 'listar' });
  assert.equal(r.decisao, 'negado'); assert.match(r.motivo, /não têm nada em comum/);
});

test('ação: os dois lados em aprovacao_humana => aprovação; qualquer outro => negado; nunca "permitido"', () => {
  let r = decidir({ estado: ESTADO, slug: 'ana', fonte: 'email', operacao: 'enviar', acao: 'enviar_email' });
  assert.equal(r.decisao, 'aprovacao'); assert.match(r.motivo, /aprovação de uma pessoa/);
  r = decidir({ estado: ESTADO, slug: 'bia', fonte: 'email', operacao: 'enviar', acao: 'enviar_email' });
  assert.equal(r.decisao, 'negado'); assert.match(r.motivo, /pessoa caio não tem a ação "enviar_email"/);
  r = decidir({ estado: ESTADO, slug: 'ana', fonte: 'pasta', operacao: 'apagar', acao: 'apagar_arquivo' });
  assert.equal(r.decisao, 'negado'); assert.match(r.motivo, /pessoa marta não tem a ação "apagar_arquivo"/);
  // operação desconhecida sem ação
  r = decidir({ estado: ESTADO, slug: 'ana', fonte: 'agenda', operacao: 'apagar' });
  assert.equal(r.decisao, 'negado'); assert.match(r.motivo, /não é leitura nem uma ação conhecida/);
});

test('agente fora do arquivo, política inválida, pessoa ou papel sumidos e entrada estranha: tudo negado', () => {
  assert.match(decidir({ estado: ESTADO, slug: 'zed', fonte: 'agenda', operacao: 'listar' }).motivo, /zed não está no arquivo de papéis/);
  assert.match(decidir({ estado: { ok: false, erro: 'arquivo quebrado', politica: { pessoas: {}, papeis: {}, agentes: {} } }, slug: 'ana', fonte: 'agenda', operacao: 'listar' }).motivo, /arquivo quebrado/);
  assert.match(decidir({ estado: ESTADO, slug: '', fonte: 'agenda', operacao: 'listar' }).motivo, /sem identidade/);
  const semPessoa = { ok: true, politica: { pessoas: {}, papeis: POLITICA.papeis, agentes: POLITICA.agentes } };
  assert.match(decidir({ estado: semPessoa, slug: 'ana', fonte: 'agenda', operacao: 'listar' }).motivo, /pessoa "marta" .* não existe mais/);
  const semPapel = { ok: true, politica: { pessoas: POLITICA.pessoas, papeis: {}, agentes: POLITICA.agentes } };
  assert.match(decidir({ estado: semPapel, slug: 'ana', fonte: 'agenda', operacao: 'listar' }).motivo, /papel "recepcao" .* não existe mais/);
  for (const ruim of [null, undefined, 42, { estado: null }, { estado: ESTADO, slug: { x: 1 }, fonte: 'agenda', operacao: 'listar' }]) {
    assert.equal(decidir(ruim).decisao, 'negado');
  }
  // exceção interna vira negado (política com getter que lança)
  const explosiva = { ok: true, politica: { get agentes() { throw new Error('boom'); } } };
  const r = decidir({ estado: explosiva, slug: 'ana', fonte: 'agenda', operacao: 'listar' });
  assert.equal(r.decisao, 'negado'); assert.match(r.motivo, /Falha interna .*boom/);
});

test('o slug que decide é o recebido, nunca algo dentro da entrada que pareça identidade', () => {
  // mesmo que a entrada traga "agente"/"dono" extras, só `slug` conta
  const r = decidir({ estado: ESTADO, slug: 'bia', agente: 'ana', dono: 'marta', fonte: 'clientes', operacao: 'listar' });
  assert.equal(r.pessoa, 'caio'); assert.deepEqual(r.campos, ['email']);
});

test('pessoa desligada é negada em fonte e em ação; nomes do protótipo não viram agente, fonte nem ação', () => {
  const pol = JSON.parse(JSON.stringify(POLITICA));
  pol.pessoas.marta.estado = 'desligada';
  const est = { ok: true, politica: pol };
  let r = decidir({ estado: est, slug: 'ana', fonte: 'agenda', operacao: 'listar' });
  assert.equal(r.decisao, 'negado'); assert.match(r.motivo, /marta está desligada/);
  r = decidir({ estado: est, slug: 'ana', fonte: 'email', operacao: 'enviar', acao: 'enviar_email' });
  assert.equal(r.decisao, 'negado'); assert.match(r.motivo, /desligada/);
  for (const nome of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(decidir({ estado: ESTADO, slug: nome, fonte: 'agenda', operacao: 'listar' }).decisao, 'negado', `agente ${nome}`);
    assert.equal(decidir({ estado: ESTADO, slug: 'ana', fonte: nome, operacao: 'listar' }).decisao, 'negado', `fonte ${nome}`);
    assert.equal(decidir({ estado: ESTADO, slug: 'ana', fonte: 'email', operacao: 'x', acao: nome }).decisao, 'negado', `ação ${nome}`);
  }
});
