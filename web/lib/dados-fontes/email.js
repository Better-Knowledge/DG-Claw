'use strict';
// Fonte "email": só ação, e simulada. Enviar NÃO manda e-mail nenhum nesta versão: depois que uma pessoa
// aprova no painel, a mensagem é gravada em <dir>/email-enviados.jsonl. Serve para provar o caminho
// completo (pedido do agente -> aprovação da ação exata -> execução) sem ligar um sistema real.

const fs = require('node:fs');
const path = require('node:path');
const { ErroFonte, soChaves, semInvisivel } = require('./json');

const RX_EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;
const MAX_ASSUNTO = 200;
const MAX_TEXTO = 10000;

function fonteEmail({ dir, nome, agora, catalogo }) {
  const relogio = agora || (() => Date.now());
  const arquivo = path.join(dir, `${nome}-enviados.jsonl`);
  return {
    nome, catalogo, campos: [],
    operacoes: {},
    acoes: {
      enviar: {
        acao: 'enviar_email',
        /** Valida e devolve só os campos aceitos, limpos. É isto que vai para a aprovação e para o hash. */
        validar(p) {
          soChaves(p || {}, ['para', 'assunto', 'texto'], `enviar em ${nome}`);
          if (typeof p.para !== 'string' || !RX_EMAIL.test(p.para)) throw new ErroFonte(400, '"para" é obrigatório: um único endereço de e-mail simples (letras, números, . _ % + - antes do @, domínio depois), sem vírgula, ponto e vírgula ou outro caractere.');
          if (typeof p.assunto !== 'string' || !p.assunto.trim() || p.assunto.length > MAX_ASSUNTO || /[\r\n]/.test(p.assunto)) throw new ErroFonte(400, `"assunto" é obrigatório: uma linha de até ${MAX_ASSUNTO} caracteres.`);
          if (typeof p.texto !== 'string' || !p.texto.trim() || p.texto.length > MAX_TEXTO) throw new ErroFonte(400, `"texto" é obrigatório, com até ${MAX_TEXTO} caracteres.`);
          semInvisivel(p.assunto, '"assunto"'); semInvisivel(p.texto, '"texto"');
          return { para: p.para, assunto: p.assunto.trim(), texto: p.texto };
        },
        executar(p, contexto) {
          const linha = JSON.stringify({ em: new Date(relogio()).toISOString(), para: p.para, assunto: p.assunto, texto: p.texto, agente: contexto.agente, aprovado_por: contexto.aprovado_por, aprovacao: contexto.aprovacao });
          try {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            fs.appendFileSync(arquivo, linha + '\n', { mode: 0o600 });
          } catch (e) {
            throw new ErroFonte(503, `Não consegui registrar o e-mail simulado (${e.code || 'falha de gravação'}). Nada foi enviado; avise o dono para conferir a pasta de dados do Web.`);
          }
          return { enviado: false, simulado: true, para: p.para, assunto: p.assunto };
        },
      },
    },
  };
}

module.exports = { fonteEmail };
