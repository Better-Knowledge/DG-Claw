# Skills por escopo: global, do grupo ou de um agente

Uma **skill** é um roteiro (`SKILL.md`) que o agente lê antes de fazer um trabalho. Até aqui cada agente tinha
as skills da imagem e as que ele mesmo aprendeu, na própria casa. Agora existe um **catálogo compartilhado** em
`/var/lib/dgclaw/skills`, com três escopos, e cada agente recebe só as que o papel dele libera:

| Escopo | Pasta | Quem recebe |
| --- | --- | --- |
| global | `globais/<skill>/` | todo agente cujo papel lista a skill (ou `"*"`) |
| grupo | `grupos/<grupo>/<skill>/` | idem, e só se a pessoa do agente está no grupo |
| agente | `agentes/<slug>/<skill>/` | só aquele agente, sempre |

Cada agente recebe uma **vista** própria do catálogo (`/var/lib/dgclaw/skills/.vistas/<slug>/`, cópias de root
só das skills que a política libera para ele), montada **só leitura** em `/run/dgclaw/skills` dentro do
container; o que o agente vê em `~/.claude/skills` são links para elas. O agente não enxerga as skills dos
outros escopos nem altera o catálogo: ele **propõe** uma skill para o grupo dele, e uma pessoa aprova no painel.
Quando o mesmo nome existe em mais de um escopo que o agente recebe, a **mais específica vence** (agente > grupo >
global; entre dois grupos da mesma pessoa, vence o grupo de nome alfabeticamente maior): a skill privada de um
agente nunca é trocada por uma de grupo de mesmo nome. Por isso a proposta de um agente recusa o nome de uma
skill global (sem dizer que ela existe), e o `publicar` avisa quando o nome já existe em outro escopo.
A pasta da vista é sempre a mesma (só o conteúdo dela é trocado): o container montado nela enxerga a mudança
na hora, mesmo ligado.

## Para o dono

```bash
sudo dgclaw skill publicar ./fechamento-mensal --escopo global
sudo dgclaw skill publicar ./conciliacao --escopo grupo:financeiro
sudo dgclaw skill publicar ./so-da-ana --escopo agente:ana
sudo dgclaw skill listar
sudo dgclaw skill remover conciliacao --escopo grupo:financeiro     # vai para /var/lib/dgclaw/skills-aposentadas
sudo dgclaw skill aplicar [<slug>]                                   # refaz os links pela política atual
```

`publicar` copia a pasta (a que tem o `SKILL.md`) para uma pasta temporária de root e **confere a cópia** (a
origem pode ser a casa de um agente), com dono root, pastas 755 e arquivos 644; recusa: atalho ou fifo, arquivo
que não é texto, pasta acima de 2 MB, `name` do frontmatter diferente do nome da pasta, **nome de uma skill da
imagem do DG Claw** (`memory`, `aprender`, `agenda`...: uma compartilhada com esse nome tomaria o lugar da nativa)
e qualquer coisa que pareça segredo (os padrões ficam em `lib/segredos.regex`, os mesmos que o Web usa). **Skill
é lida por todo agente que a recebe**: ela diz onde pegar a chave (o cofre), nunca o valor.

Depois de publicar, remover ou mudar o bloco `skills` de um papel, rode `sudo dgclaw skill aplicar`: ele refaz
a vista e os links em cada agente ligado (vale na próxima sessão). `dgclaw agente criar`, `agente iniciar` e
`agente reparar` fazem isso sozinhos.

## Grupos e papéis

Em `/etc/dgclaw/papeis.json`:

```json
"papeis":  { "analista": { "skills": ["*"] }, "estagiario": { "skills": ["fechamento-mensal"] } },
"pessoas": { "marta": { "grupos": ["financeiro"], "skills": { "conciliacao": "negado" } } }
```

- O **papel** lista as skills compartilhadas que libera (nome exato ou `"*"`). Sem o bloco, nenhuma skill
  compartilhada entra (as da imagem e as do próprio agente continuam).
- A **pessoa** só nega (`"negado"`), por nome.
- Skill de grupo exige a pessoa no grupo. Pessoa desligada não recebe nenhuma.
- Agente fora do arquivo de papéis (ou arquivo inválido) recebe só as próprias (`agentes/<slug>`).

## Para o agente: propor uma skill para o grupo

Quando um processo deu certo e serve a mais gente do grupo, a skill `aprender` pode propor em vez de guardar só
na própria casa:

```bash
dgclaw-api POST /api/v1/dados/fontes/skills/propor '{"nome": "relatorio-semanal", "grupo": "financeiro", "conteudo": "---\nname: relatorio-semanal\ndescription: ...\n---\n..."}'
dgclaw-api POST /api/v1/dados/fontes/skills/propor '{"nome": "relatorio-semanal", "grupo": "financeiro", "conteudo": "...", "substituir": true}'   # trocar o texto de uma que já existe
```

Ou pelas tools `dados_chamar` com `fonte: "skills"`. Regras: a pessoa do agente precisa estar no `grupo`; a
ação `propor_skill` precisa estar em `aprovacao_humana` na pessoa e no papel; `conteudo` é o `SKILL.md` inteiro
(frontmatter com `name` igual ao nome e `description`), até 60 KB, sem caracteres invisíveis e sem segredo; o
nome não pode ser o de uma skill da imagem. Skill que já existe no grupo só é trocada com `"substituir": true`,
e a pessoa vê na tela, em destaque, que é uma substituição; skill publicada pelo dono com mais arquivos além
do `SKILL.md` um agente não substitui. A proposta vira um pedido na tela Dados; aprovada (e com a pessoa ainda
no grupo), o Web grava em `grupos/<grupo>/<nome>/SKILL.md` e os agentes do grupo a recebem no próximo
`dgclaw skill aplicar`. Ninguém propõe para o escopo global: ali só o dono. O agente não lista o catálogo dos
outros escopos: o que ele tem está em `~/.claude/skills`.

## Segurança e limites

- Só a vista do agente é montada, de root e só leitura: ele não lê as skills dos outros escopos nem muda uma
  compartilhada (é link para a cópia de root). O que ele pode mudar é o que está na casa dele (as skills que ele
  mesmo aprendeu). Ele pode criar links à mão, mas só para o que já está na vista dele.
- Skill é instrução que o modelo segue: só o dono publica em escopo compartilhado, e a proposta de um agente só
  entra com aprovação humana do texto inteiro. O conteúdo passa pelo mesmo filtro de caracteres invisíveis e
  de segredo da escrita em base.
- Os links são refeitos por `skill aplicar`, `agente reparar` e na criação; uma skill removida do catálogo
  some do agente nessa hora, não antes. O que o agente já leu continua na memória dele.
- Os agentes existentes ganham a montagem quando o container é recriado: o `dgclaw atualizar` já recria os
  que estavam ligados; agente que estava desligado na hora precisa de `sudo dgclaw agente recriar <slug>` depois
  de ligado. O CHANGELOG explica.
