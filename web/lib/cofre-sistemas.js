'use strict';
// Cofre de sistemas: UMA credencial por sistema (CRM, ERP, servidor MCP...), em /etc/dgclaw/cofre-sistemas/<nome>
// (root, 600). O agente nunca a recebe: o gateway (web/lib/dados-fontes/ferramenta.js) lê o arquivo na hora da
// chamada e a injeta no cabeçalho, no ambiente do servidor MCP ou onde o adaptador mandar. É isto que troca
// "600 credenciais" (uma por agente por sistema) por "uma por sistema": revogar a pessoa derruba o acesso dela
// sem mexer em credencial nenhuma. Quem grava é o dgclaw sistema credencial <nome> (valor pelo STDIN).

const fs = require('node:fs');
const path = require('node:path');

const RX_NOME = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_BYTES = 8 * 1024;

class ErroCredencial extends Error {
  constructor(mensagem, codigo) { super(mensagem); this.name = 'ErroCredencial'; this.code = codigo || 'CREDENCIAL'; }
}

function criarCofreSistemas({ dir }) {
  /**
   * Devolve o valor (texto, sem a quebra de linha final). Lança ErroCredencial com mensagem SEM o valor:
   * ausente, permissão aberta demais, atalho ou arquivo grande demais.
   */
  function ler(nome) {
    if (typeof nome !== 'string' || !RX_NOME.test(nome)) throw new ErroCredencial(`O nome de credencial ${JSON.stringify(String(nome).slice(0, 40))} não vale.`, 'NOME');
    const arq = path.join(dir, nome);
    let st;
    try { st = fs.lstatSync(arq); } catch (e) {
      if (e.code === 'ENOENT') throw new ErroCredencial(`A credencial "${nome}" não está no cofre de sistemas. O dono grava com: printf %s "$VALOR" | sudo dgclaw sistema credencial ${nome}`, 'AUSENTE');
      throw new ErroCredencial(`Não consegui conferir a credencial "${nome}" (${e.code || e.message}).`, 'LEITURA');
    }
    if (st.isSymbolicLink() || !st.isFile()) throw new ErroCredencial(`A credencial "${nome}" não é um arquivo comum (atalho?); recusada.`, 'ATALHO');
    if (st.mode & 0o077) throw new ErroCredencial(`O arquivo da credencial "${nome}" está legível por outros usuários (modo ${(st.mode & 0o777).toString(8)}); recusada. Corrija com: sudo chmod 600 ${arq}`, 'MODO');
    if (st.uid !== 0) throw new ErroCredencial(`O arquivo da credencial "${nome}" não pertence ao root; recusada.`, 'DONO');
    if (st.size > MAX_BYTES) throw new ErroCredencial(`A credencial "${nome}" passa de ${MAX_BYTES} bytes; recusada.`, 'TAMANHO');
    let fd = null;
    try {
      fd = fs.openSync(arq, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const buf = Buffer.alloc(MAX_BYTES);
      const n = fs.readSync(fd, buf, 0, MAX_BYTES, 0);
      const v = buf.toString('utf8', 0, n).replace(/\r?\n$/, '');
      if (!v) throw new ErroCredencial(`A credencial "${nome}" está vazia.`, 'VAZIA');
      return v;
    } finally { if (fd != null) fs.closeSync(fd); }
  }

  /** Só os nomes cadastrados (nunca valores), para o dono conferir. */
  function nomes() {
    try { return fs.readdirSync(dir).filter((n) => RX_NOME.test(n)).sort(); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }

  return { ler, nomes, ErroCredencial };
}

module.exports = { criarCofreSistemas, ErroCredencial, RX_NOME };
