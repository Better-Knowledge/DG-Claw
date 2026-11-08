'use strict';
// Edição do /etc/dgclaw/papeis.json pelo Web (painel /acessos). Regras:
// - lê o arquivo inteiro, muda SÓ o que foi pedido no objeto bruto (chaves que o validador não conhece, como
//   "comentario", ficam como estão) e grava com a mesma indentação de 2 espaços;
// - nada é gravado se o resultado não passar pelo validaPapeis (um arquivo inválido fecha toda a rota de dados);
// - gravação atômica (temporário na mesma pasta + rename), modo 600, sob uma trava por pasta (mkdir), e com
//   conferência de que o arquivo não mudou entre a leitura e a escrita (a CLI e o dono no editor também o escrevem).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validaPapeis } = require('./papeis');

const TRAVA_VELHA_MS = 10 * 1000;   // trava órfã (processo morto) é removida depois disto
const ESPERA_MAX_MS = 2 * 1000;    // a espera bloqueia o Web: curta, e o chamador tenta de novo
const DORME = new Int32Array(new SharedArrayBuffer(4));
const VAZIO = () => ({ versao: 1, pessoas: {}, papeis: {}, agentes: {} });

class ErroEdicao extends Error {
  constructor(mensagem, status, erros) { super(mensagem); this.name = 'ErroEdicao'; this.status = status || 500; this.erros = erros || null; }
}

function criarPapeisEditor({ caminho, log }) {
  const trava = `${caminho}.trava`;

  function marca() {
    try { const st = fs.statSync(caminho); return `${st.ino}:${st.mtimeMs}:${st.size}`; } catch (e) {
      if (e.code === 'ENOENT') return 'ausente';
      throw new ErroEdicao(`Não consegui ler ${caminho} (${e.code || e.message}).`, 503);
    }
  }

  /** O JSON bruto do arquivo (ou o vazio, se ele não existe). Arquivo ilegível ou inválido: erro 409 com o motivo. */
  function lerBruto() {
    let texto;
    try { texto = fs.readFileSync(caminho, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return VAZIO();
      throw new ErroEdicao(`Não consegui ler ${caminho} (${e.code || e.message}).`, 503);
    }
    let bruto;
    try { bruto = JSON.parse(texto); } catch (e) {
      throw new ErroEdicao(`O arquivo de papéis não é um JSON válido (${e.message}). Corrija-o no servidor antes de editar pelo painel; enquanto isso toda a rota de dados está fechada.`, 409);
    }
    if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) throw new ErroEdicao('O arquivo de papéis precisa ser um objeto JSON.', 409);
    return bruto;
  }

  function comTrava(fn) {
    const limite = Date.now() + ESPERA_MAX_MS;
    for (;;) {
      try { fs.mkdirSync(trava); break; } catch (e) {
        if (e.code !== 'EEXIST') throw new ErroEdicao(`Não consegui criar a trava ${trava} (${e.code || e.message}).`, 503);
      }
      let idade = 0;
      try { idade = Date.now() - fs.statSync(trava).mtimeMs; } catch (_) { continue; }
      // Trava órfã: renomear antes de apagar, porque o rename é atômico e só um dos processos que a acharam velha ganha;
      // o outro vê ENOENT e volta ao mkdir, em vez de apagar a trava nova de quem ganhou.
      if (idade > TRAVA_VELHA_MS) {
        const velha = `${trava}.velha.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
        try { fs.renameSync(trava, velha); fs.rmdirSync(velha); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        continue;
      }
      if (Date.now() > limite) throw new ErroEdicao(`Outra edição do arquivo de papéis está em andamento (${trava}). Tente de novo em instantes.`, 503);
      Atomics.wait(DORME, 0, 0, 20);
    }
    try { return fn(); } finally {
      try { fs.rmdirSync(trava); } catch (e) { if (e.code !== 'ENOENT') log('aviso', `Não consegui soltar a trava ${trava} (${e.code || e.message}).`); }
    }
  }

  function gravar(bruto) {
    const dir = path.dirname(caminho);
    const tmp = path.join(dir, `.${path.basename(caminho)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(bruto, null, 2) + '\n', { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, caminho);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* não existia */ }
      throw new ErroEdicao(`Não consegui gravar ${caminho} (${e.code || e.message}). Nada mudou.`, 503);
    }
  }

  return {
    caminho,
    lerBruto,
    /**
     * Edita sob trava: `fn(bruto)` muda o objeto no lugar. O resultado passa pelo validaPapeis; se não passar,
     * nada é gravado e o erro traz a lista de motivos. Devolve { politica } normalizada.
     */
    editar(fn) {
      return comTrava(() => {
        const antes = marca();
        const bruto = lerBruto();
        for (const k of ['pessoas', 'papeis', 'agentes']) if (bruto[k] === undefined) bruto[k] = {};
        if (bruto.versao === undefined) bruto.versao = 1;
        fn(bruto);
        const r = validaPapeis(bruto);
        if (!r.ok) throw new ErroEdicao(`A mudança deixaria o arquivo de papéis inválido (e um arquivo inválido fecha toda a rota de dados); nada foi gravado. ${r.erros.join(' ')}`, 400, r.erros);
        if (marca() !== antes) throw new ErroEdicao('O arquivo de papéis mudou no servidor enquanto você editava. Recarregue a tela e refaça a mudança.', 409);
        gravar(bruto);
        return { politica: r.politica };
      });
    },
  };
}

module.exports = { criarPapeisEditor, ErroEdicao };
