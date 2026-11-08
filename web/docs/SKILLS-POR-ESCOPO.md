# Skills por escopo: global, do grupo ou de um agente

Uma **skill** é um roteiro (`SKILL.md`) que o agente lê antes de fazer um trabalho. Até aqui cada agente tinha
as skills da imagem e as que ele mesmo aprendeu, na própria casa. Agora existe um **catálogo compartilhado** em
`/var/lib/dgclaw/skills`, com três escopos, e cada agente recebe só as que o papel dele libera:

| Escopo | Pasta | Quem recebe |
| --- | --- | --- |
| global | `globais/<skill>/` | todo agente cujo papel lista a skill (ou `"*"`) |
| grupo | `grupos/<grupo>/<skill>/` | idem, e só se a pessoa do agente está no grupo |
| agente | `agentes/<slug>/<skill>/` | só aquele agente, sempre |

A pasta é montada **só leitura** em `/run/dgclaw/skills` dentro de cada container; o que o agente vê em
`~/.claude/skills` são links para as skills liberadas. O agente não altera o catálogo: ele **propõe** uma skill
para o grupo dele, e uma pessoa aprova no painel.

## Para o dono

```bash
sudo dgclaw skill publicar ./fechamento-mensal --escopo global
sudo dgclaw skill publicar ./conciliacao --escopo grupo:financeiro
sudo dgclaw skill publicar ./so-da-ana --escopo agente:ana
sudo dgclaw skill listar
sudo dgclaw skill remover conciliacao --escopo grupo:financeiro     # vai para /var/lib/dgclaw/skills-aposentadas
sudo dgclaw skill aplicar [<slug>]                                   # refaz os links pela política atual
```

`publicar` copia a pasta (a que tem o `SKILL.md`) com dono root, pastas 755 e arquivos 644, e recusa: atalho,
arquivo que não é texto, pasta acima de 2 MB, `name` do frontmatter diferente do nome da pasta, e qualquer coisa
que pareça segredo (chave, token, senha). **Skill é lida por todo agente que a recebe**: ela diz onde pegar a
chave (o cofre), nunca o valor.

Depois de publicar, remover ou mudar o bloco `skills` de um papel, rode `sudo dgclaw skill aplicar`: ele refaz
os links em cada agente ligado (vale na próxima sessão). `dgclaw agente criar` e `agente reparar` fazem isso
sozinhos.

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
dgclaw-api POST /api/v1/dados/fontes/skills/listar '{}'      # o catálogo compartilhado (global e grupos)
```

Ou pelas tools `dados_chamar` com `fonte: "skills"`. Regras: a pessoa do agente precisa estar no `grupo`; a
ação `propor_skill` precisa estar em `aprovacao_humana` na pessoa e no papel; `conteudo` é o `SKILL.md` inteiro
(frontmatter com `name` igual ao nome e `description`), até 60 KB, sem caracteres invisíveis e sem segredo.
A proposta vira um pedido na tela Dados; aprovada, o Web grava em `grupos/<grupo>/<nome>/SKILL.md` e os
agentes do grupo a recebem no próximo `dgclaw skill aplicar`. Ninguém propõe para o escopo global: ali só o dono.

## Segurança e limites

- O catálogo é de root e só leitura no container; o agente não consegue mudar uma skill compartilhada nem
  a sua cópia (é link). O que ele pode mudar é o que está na casa dele (as skills que ele mesmo aprendeu).
- Skill é instrução que o modelo segue: só o dono publica em escopo compartilhado, e a proposta de um agente só
  entra com aprovação humana do texto inteiro. O conteúdo passa pelo mesmo filtro de caracteres invisíveis e
  de segredo da escrita em base.
- Os links são refeitos por `skill aplicar`, `agente reparar` e na criação; uma skill removida do catálogo
  some do agente nessa hora, não antes. O que o agente já leu continua na memória dele.
- Esta versão exige recriar o container dos agentes existentes para a pasta ser montada
  (`sudo dgclaw agente recriar <slug> --forcar`); o CHANGELOG explica.
