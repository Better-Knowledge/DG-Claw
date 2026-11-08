# Acessos dos agentes: o painel que edita o arquivo de papéis

A tela **Acessos dos agentes** (menu ☰, `/acessos`, só o dono) mostra, agente por agente, **o que ele alcança de
fato** (fontes e campos, bases por escopo, escopos de ferramentas, skills compartilhadas e ações com aprovação) e
edita `/etc/dgclaw/papeis.json` pelo Web: a pessoa e o papel de cada agente, os blocos de cada papel e de cada
pessoa, e os grupos. É a mesma coisa que editar o arquivo à mão, com três garantias:

1. **Nada é gravado se o arquivo ficar inválido.** Toda mudança passa pelo mesmo `validaPapeis` que o Web usa
   para decidir; um arquivo inválido fecharia toda a rota de dados, por isso a gravação é recusada com a lista
   dos motivos.
2. **O que o painel não conhece fica como está.** A edição muda só as chaves pedidas no JSON bruto; `comentario`
   e qualquer campo seu sobrevivem.
3. **Gravação atômica, 600, sob trava**, e recusada se o arquivo mudou no servidor entre a leitura e a escrita
   (outra pessoa, a CLI, o editor).

O "efetivo" é calculado pelas mesmas funções de decisão da rota (`decidir`, `decidirBase`, `decidirFerramenta`)
e pela mesma regra das skills (`skills_permitidas`): pessoa ∩ papel, escopo dos grupos, pessoa desligada = nada.

## Rotas (só o dono)

| Rota | O que faz |
| --- | --- |
| `GET /api/v1/acessos` | `{ politica_ok, erro, agentes: [{ slug, nome, pessoa, papel, colaboradores: [{ email, nome }], efetivo }], pessoas, papeis, grupos, bruto, catalogos }` |
| `POST /api/v1/acessos/agente/<slug>` | `{ pessoa, papel }` liga o agente; `{ remover: true }` tira do arquivo |
| `POST /api/v1/acessos/papel/<nome>` | `{ fontes?, bases?, ferramentas?, skills?, acoes? }` cria ou troca os blocos dados (`null` apaga um bloco) |
| `DELETE /api/v1/acessos/papel/<nome>` | remove (409 se algum agente usa) |
| `POST /api/v1/acessos/pessoa/<nome>` | `{ nome?, grupos?, estado?, fontes?, bases?, ferramentas?, skills?, acoes? }` |
| `DELETE /api/v1/acessos/pessoa/<nome>` | remove (409 se algum agente é dela) |
| `POST /api/v1/acessos/grupo/<nome>` | `{ nome?, tipo? }` |
| `DELETE /api/v1/acessos/grupo/<nome>` | remove (409 se alguma pessoa está nele) |

`catalogos` traz o que existe para marcar: as fontes fixas (com campos, operações e ações), as bases do catálogo
(com escopo), as ferramentas (com os escopos e as operações de cada um) e as skills compartilhadas publicadas (com
o escopo). A tela monta os formulários a partir daí; o formato que ela grava é exatamente o de
`web/docs/DADOS-POR-PAPEL.md`, `BASES-DE-CONHECIMENTO.md`, `FERRAMENTAS-POR-ESCOPO.md` e `SKILLS-POR-ESCOPO.md`.

## O que muda na hora e o que não

- Fontes, bases, ferramentas e ações: o Web relê o arquivo sozinho; vale no próximo pedido do agente, e os
  pedidos de aprovação pendentes de quem perdeu acesso caem.
- Skills compartilhadas: a vista e os links do agente mudam no próximo `dgclaw skill aplicar`, `agente reparar` ou
  `agente iniciar` (a tela avisa).
- Pessoa `desligada` pela tela nega tudo na hora, mas não para os agentes nem entrega a memória: para isso existe
  `dgclaw pessoa desligar` (`docs/PROPRIEDADE-DO-CONHECIMENTO.md`).

## Limites

- A tela edita o arquivo inteiro de uma vez por chamada e recusa se ele mudou no meio; duas pessoas editando ao
  mesmo tempo veem o aviso e recarregam.
- Campos de fonte fora do catálogo (uma fonte nova que ainda não existe) não aparecem para marcar; o arquivo
  continua aceitando o que o validador aceita, à mão.
