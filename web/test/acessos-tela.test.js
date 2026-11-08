'use strict';
// Tela /acessos: as funções puras que montam o efetivo, o cartão do agente, o formulário dos blocos e a leitura de volta.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../public/acessos');

const CAT = {
  fontes: [{ nome: 'agenda', campos: [], operacoes: ['listar', 'buscar'], acoes: {} }, { nome: 'clientes', campos: ['nome', 'telefone', 'cpf'], operacoes: ['listar'], acoes: {} }, { nome: 'email', campos: [], operacoes: [], acoes: { enviar: 'enviar_email' } }],
  bases: { ok: true, itens: [{ nome: 'manual-rh', escopo: 'empresa', grupo: null, pessoa: null }, { nome: 'fechamento', escopo: 'grupo', grupo: 'financeiro', pessoa: null }] },
  ferramentas: { ok: true, itens: [{ nome: 'crm', titulo: 'CRM', tipo: 'api', escopos: [{ escopo: 'crm:ler', operacoes: ['clientes_listar'] }, { escopo: 'crm:escrever', operacoes: ['proposta_criar (ação)'] }] }] },
  skills: [{ nome: 'fechamento-mensal', escopo: 'global' }, { nome: 'conciliacao', escopo: 'grupo:financeiro' }, { nome: 'so-da-ana', escopo: 'agente:ana' }],
};

test('o efetivo e o cartão do agente escapam HTML e avisam quando o agente está fora do arquivo', () => {
  const ef = { fontes: [{ nome: 'clientes', campos: ['nome'] }], bases: [{ nome: 'manual-rh', escopo: 'empresa' }], ferramentas: [{ nome: 'crm', escopos: ['crm:ler'] }], skills: ['x<y'], acoes: ['enviar_email (email)'] };
  const h = T.htmlEfetivo(ef);
  assert.ok(h.includes('clientes <small>(nome)</small>')); assert.ok(h.includes('x&lt;y')); assert.ok(h.includes('crm:ler'));
  const a = T.htmlAgente({ slug: 'bia', nome: 'Bia <b>', pessoa: null, papel: null, colaboradores: [], efetivo: {} }, ['marta'], ['recepcao']);
  assert.ok(a.includes('não está no arquivo de papéis')); assert.ok(a.includes('Bia &lt;b&gt;')); assert.ok(!a.includes('data-acao="tirar"'));
  assert.ok(a.includes('nenhum colaborador convidado'));
  const b = T.htmlAgente({ slug: 'ana', nome: 'Ana', pessoa: 'marta', papel: 'recepcao', colaboradores: [{ email: 'marta@x.com', nome: 'Marta <i>' }, { email: 'edu@x.com', nome: '' }], efetivo: {} }, ['marta'], ['recepcao']);
  assert.ok(b.includes('<option value="marta" selected>')); assert.ok(b.includes('data-acao="tirar"')); assert.ok(b.includes('Marta &lt;i&gt; (marta@x.com), edu@x.com'));
});

test('formulário do papel: marca o que o arquivo tem; a leitura devolve os blocos no formato do arquivo', () => {
  const bruto = { fontes: { agenda: 'leitura', clientes: { nivel: 'leitura', campos: ['nome', 'telefone'] } }, bases: { '*': 'leitura' }, ferramentas: ['crm:ler'], skills: ['*'], acoes: { enviar_email: 'aprovacao_humana' }, comentario: 'x' };
  const h = T.formBlocos('recepcao', bruto, CAT, false);
  assert.ok(h.includes('name="fonte" value="agenda" checked')); assert.ok(h.includes('name="fonte" value="clientes" checked'));
  assert.ok(h.includes('name="campos:clientes" value="nome, telefone"'));
  assert.ok(h.includes('name="base" value="*" checked')); assert.ok(h.includes('name="ferramenta" value="crm:ler" checked')); assert.ok(h.includes('name="ferramenta" value="crm:escrever">'));
  assert.ok(h.includes('name="skill" value="*" checked')); assert.ok(!h.includes('value="so-da-ana"'), 'skill privada de agente não entra no papel');
  assert.ok(h.includes('name="acao" value="enviar_email" checked')); assert.ok(h.includes('name="acao" value="escrever_base"')); assert.ok(h.includes('name="acao" value="propor_skill"'));
  assert.ok(h.includes('data-acao="remover"'));
  assert.ok(!T.formBlocos('novo', null, CAT, false).includes('data-acao="remover"'), 'papel novo não tem remover');
  const campos = [
    { name: 'fonte', value: 'agenda', checked: true }, { name: 'fonte', value: 'clientes', checked: true }, { name: 'campos:clientes', value: ' nome , telefone ', checked: true }, { name: 'campos:agenda', value: '', checked: true },
    { name: 'base', value: '*', checked: true }, { name: 'base', value: 'manual-rh', checked: false },
    { name: 'ferramenta', value: 'crm:ler', checked: true }, { name: 'skill', value: 'conciliacao', checked: true }, { name: 'acao', value: 'enviar_email', checked: true }, { name: 'acao', value: 'escrever_base', checked: false },
  ];
  assert.deepEqual(T.lerBlocos(campos, false), { fontes: { agenda: 'leitura', clientes: { nivel: 'leitura', campos: ['nome', 'telefone'] } }, bases: { '*': 'leitura' }, ferramentas: ['crm:ler'], acoes: { enviar_email: 'aprovacao_humana' }, skills: ['conciliacao'] });
});

test('formulário da pessoa: grupos, estado, negações por nome; a leitura devolve o bloco da pessoa', () => {
  const bruto = { nome: 'Marta', grupos: ['financeiro'], estado: 'ativa', bases: { fechamento: 'negado' }, skills: { conciliacao: 'negado' }, fontes: {} };
  const h = T.formBlocos('marta', bruto, CAT, true, ['financeiro', 'projeto-x']);
  assert.ok(h.includes('name="grupo" value="financeiro" checked')); assert.ok(h.includes('name="grupo" value="projeto-x">'));
  assert.ok(h.includes('name="base_negada" value="fechamento" checked')); assert.ok(h.includes('name="skill_negada" value="conciliacao" checked'));
  assert.ok(h.includes('value="ativa" selected'));
  const campos = [{ name: 'nome', value: ' Marta S ', checked: true }, { name: 'estado', value: 'desligada', checked: true }, { name: 'grupo', value: 'financeiro', checked: true }, { name: 'fonte', value: 'agenda', checked: true }, { name: 'base', value: '*', checked: true }, { name: 'base_negada', value: 'fechamento', checked: true }, { name: 'skill_negada', value: 'conciliacao', checked: true }];
  assert.deepEqual(T.lerBlocos(campos, true), { fontes: { agenda: 'leitura' }, bases: { '*': 'leitura', fechamento: 'negado' }, ferramentas: [], acoes: {}, skills: { conciliacao: 'negado' }, grupos: ['financeiro'], estado: 'desligada', nome: 'Marta S' });
  const g = T.htmlGrupo('financeiro', { tipo: 'departamento', nome: 'Financeiro' }, { marta: { grupos: ['financeiro'] } });
  assert.ok(g.includes('marta')); assert.ok(!g.includes('remover-grupo'), 'grupo com pessoa não tem remover');
  assert.ok(T.htmlGrupo('vazio', { tipo: 'equipe' }, {}).includes('remover-grupo'));
});
