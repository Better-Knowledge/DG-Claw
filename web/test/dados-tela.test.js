'use strict';
// Tela /dados: arquivos ligados, menu, service worker e as funções puras que montam o HTML.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../public/menu-lado');
const T = require('../public/dados');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');

test('o menu lateral tem a entrada Dados apontando para /dados', () => {
  assert.deepEqual(M.LINK_DADOS, { nome: 'Dados', ico: '🗂', href: '/dados' });
  assert.match(pub('menu-lado.js'), /data-tour="gm-dados"/);
});

test('dados.html liga os scripts e estilos certos, e o sw.js guarda os estáticos novos (v35 ou mais)', () => {
  const h = pub('dados.html');
  for (const u of ['/dados.js', '/dados.css', '/casca.js', '/menu-lado.js', '/tour.js', '/lembretes.css']) assert.ok(h.includes(u), u);
  assert.match(h, /DGCasca\.monta\(\{ pagina: 'dados'/);
  assert.ok(!/<script[^>]*>[^<]*fetch\(/.test(h), 'nada de lógica inline');
  const s = pub('sw.js');
  assert.match(s, /dgclaw-estaticos-v(3[5-9]|[4-9][0-9])\b/);
  for (const u of ['/dados.js', '/dados.css']) assert.ok(s.includes(`'${u}'`), u);
});

test('a tela pede os pendentes numa chamada só deles, para um histórico cheio nunca esconder um cartão', () => {
  const js = pub('dados.js');
  assert.ok(js.includes("'/api/v1/dados/aprovacoes?estado=pendente&limit=500'"));
  assert.ok(js.includes("'/api/v1/dados/aprovacoes?limit=40'"));
});

test('o cartão do pedido mostra a ação exata, escapa HTML e carrega o hash para aprovar', () => {
  const p = { id: 'a'.repeat(24), hash: 'f'.repeat(64), descricao: 'A ana quer enviar um e-mail para <b>x</b>', pedido_por: 'agente:ana', pedido_em: '2026-11-08T12:00:00.000Z', expira_em: '2026-11-08T12:15:00.000Z', pessoa: 'marta', papel: 'recepcao', params: { para: 'x@exemplo.test', assunto: 'Oi "chefe"', texto: 'linha 1\n<script>alert(1)</script>', extra: { a: 1 } } };
  const h = T.htmlPedido(p, Date.parse('2026-11-08T12:03:00.000Z'));
  assert.ok(h.includes('data-hash="' + 'f'.repeat(64) + '"'));
  assert.ok(h.includes('&lt;b&gt;x&lt;/b&gt;')); assert.ok(!h.includes('<script>'));
  assert.ok(h.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(h.includes('<dt>Para</dt><dd>x@exemplo.test</dd>'));
  assert.ok(h.includes('<dt>extra</dt><dd>{&quot;a&quot;:1}</dd>'));
  assert.ok(h.includes('faltam 12 min'));
  assert.ok(h.includes('data-acao="aprovar"') && h.includes('data-acao="recusar"'));
  assert.deepEqual(T.paresDe({ texto: 't', para: 'p', zz: 1, assunto: 'a' }).map((x) => x[0]), ['Para', 'Assunto', 'Texto', 'zz']);
  assert.equal(T.prazo('2026-11-08T12:15:00.000Z', Date.parse('2026-11-08T12:20:00.000Z')), 'venceu');
  assert.equal(T.prazo('lixo'), '');
});

test('histórico, log e papéis viram HTML seguro', () => {
  const hist = T.htmlHistorico({ estado: 'executada', descricao: 'x', decidido_em: '2026-11-08T12:00:00.000Z', decidido_por: 'dono', resultado: { simulado: true } });
  assert.ok(hist.includes('dp-estado executada') && hist.includes('Executada') && hist.includes('envio simulado'));
  const rec = T.htmlHistorico({ estado: 'recusada', descricao: '<i>', motivo: 'não <b>' });
  assert.ok(rec.includes('&lt;i&gt;') && rec.includes('não &lt;b&gt;'));
  const log = T.htmlLog({ quando: '2026-11-08T12:00:00.000Z', agente: 'ana', pessoa: 'marta', papel: 'recepcao', fonte: 'folha', operacao: 'listar', decisao: 'negado', motivo: 'o papel <recepcao> nega' });
  assert.ok(log.includes('class="negado"') && log.includes('folha/listar') && log.includes('&lt;recepcao&gt;'));
  assert.ok(T.htmlLog({ quando: 'x', decisao: 'permitido', itens: 3 }).includes('3 item(ns)'));
  assert.match(T.htmlPapeis({ valido: false, erro: 'quebrado <x>' }), /dp-erro.*quebrado &lt;x&gt;/);
  assert.match(T.htmlPapeis({ valido: true, origem: 'ausente' }), /ainda não existe/);
  const ok = T.htmlPapeis({ valido: true, origem: 'arquivo', hash: 'abc', pessoas: 1, papeis: 2, agentes: ['ana'], politica: { agentes: { ana: { pessoa: 'marta', papel: 'recepcao' } } } });
  assert.ok(ok.includes('<code>ana</code> trabalha para <code>marta</code>') && ok.includes('Hash abc'));
  assert.match(T.htmlPapeis({ valido: true, origem: 'arquivo', pessoas: 0, papeis: 1, agentes: [], politica: { agentes: {} } }), /Nenhum agente ligado/);
  for (const k of ['pendentes', 'papeis', 'bases', 'ferramentas', 'log']) { const p = T.PASSOS[k]; assert.ok(p.alvo && p.titulo && p.oque && p.como && p.porque, k); }
  assert.match(T.htmlFerramentas({ valido: false, erro: '<x>' }), /dp-erro.*&lt;x&gt;/);
  assert.match(T.htmlFerramentas({ valido: true, ferramentas: {}, credenciais: [] }), /Nenhuma ferramenta no catálogo/);
  const hf = T.htmlFerramentas({ valido: true, credenciais: ['crm'], ferramentas: { crm: { titulo: 'CRM <x>', tipo: 'api', credencial: 'crm', operacoes: { listar: { escopo: 'crm:ler', acao: false }, criar: { escopo: 'crm:escrever', acao: true } } }, notion: { titulo: 'notion', tipo: 'mcp', credencial: 'notion', operacoes: {} } } });
  assert.ok(hf.includes('<code>crm</code> CRM &lt;x&gt; · api · credencial crm<br>listar <small>crm:ler</small>, criar (ação) <small>crm:escrever</small>'));
  assert.ok(hf.includes('credencial notion não está no cofre'));
  assert.ok(fs.readFileSync(path.join(__dirname, '../public/dados.html'), 'utf8').includes('id="secFerramentas"'));
  assert.match(T.htmlBases({ valido: false, erro: '<x>' }), /dp-erro.*&lt;x&gt;/);
  assert.match(T.htmlBases({ valido: true, bases: {} }), /Nenhuma base cadastrada/);
  const hb = T.htmlBases({ valido: true, bases: { 'manual-rh': { nome: 'Manual <RH>', escopo: 'empresa', classificacao: 'interno', dono: 'rh' }, 'c-x': { nome: 'c-x', escopo: 'grupo', grupo: 'projeto-x', classificacao: 'sensivel', dono: 'nao-informado' } } });
  assert.ok(hb.includes('<code>manual-rh</code> Manual &lt;RH&gt; · da empresa · interno · dono rh'));
  assert.ok(hb.includes('<code>c-x</code>  · do grupo projeto-x · sensivel</p>'));
  assert.ok(fs.readFileSync(path.join(__dirname, '../public/dados.html'), 'utf8').includes('id="secBases"'));
});
