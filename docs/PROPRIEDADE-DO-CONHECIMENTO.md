# Propriedade do conhecimento e desligamento de uma pessoa

Quando uma pessoa deixa a empresa, o que o agente dela sabe vai junto? No DG Claw, não precisa. Este
documento diz **o que fica com a empresa, o que é da pessoa e o que acontece no desligamento**. É uma
decisão da empresa, não uma promessa de conformidade legal: adapte ao seu contrato de trabalho e à sua
política de dados antes de usar com gente de verdade.

## O que é de quem

| O que | De quem | Onde fica |
| --- | --- | --- |
| Bases de conhecimento `empresa`, `grupo` e `publica` | da empresa | `/var/lib/dgclaw/bases/<base>` |
| Base `privada` de uma pessoa | da pessoa | idem, escopo `privada` |
| Skills compartilhadas (global, grupo) | da empresa | `/var/lib/dgclaw/skills` |
| Skills que o agente aprendeu na própria casa | da empresa, por esta política | `~/.claude/skills` do agente |
| Memória de trabalho do agente (`MEMORY.md`, `working-memory.md`, `memory/*.md`) | **da empresa**, por esta política | casa do agente |
| Conversas do agente com a pessoa | da empresa, com cuidado: podem ter dado pessoal | transcrições do agente |

A regra que esta política assume: **o agente é uma ferramenta de trabalho da empresa**, criado pelo dono do
DG Claw para a pessoa usar no trabalho dela; o que ele anota no trabalho é conhecimento da empresa. Se a
sua empresa decidir diferente (por exemplo, que o diário do agente é da pessoa), ajuste o
`dgclaw pessoa desligar` para não entregar a memória, e diga isso aqui.

## Como o conhecimento fica na empresa antes de alguém sair

Esperar o desligamento para "resgatar" o conhecimento tácito é tarde. O DG Claw puxa o registro para o
dia a dia:

1. **Bases de conhecimento por grupo.** Cada grupo (departamento, projeto) tem uma base, e o agente de quem
   está no grupo pode **propor** um arquivo para ela (`web/docs/BASES-DE-CONHECIMENTO.md`): um procedimento,
   uma decisão com o porquê, um contato, uma lição. A pessoa aprova no painel. Nada entra sem aprovação.
2. **A reflexão da noite** (`scripts/reflection.sh`) tem um passo para isso: ao reler o dia, o agente separa o
   que foi **conhecimento da empresa** (como se faz, por que se decidiu, com quem se fala) do que é só
   trabalho em andamento, e, se o grupo tem uma base `conhecimento-<grupo>`, anota a candidata em
   `memory/conhecimento-candidato.md` e propõe no dia seguinte com o sim da pessoa.
3. **Skills por escopo.** Um processo que deu certo vira skill; se serve ao grupo, o agente propõe para o
   grupo (`web/docs/SKILLS-POR-ESCOPO.md`).
4. **Observabilidade.** A tela Observabilidade mostra quais fontes e bases cada agente usa; um agente que
   só lê e nunca propõe é um sinal de conhecimento que está ficando só na cabeça da pessoa.

## O desligamento

```bash
sudo dgclaw pessoa desligar marta
```

1. `estado: "desligada"` no arquivo de papéis: o Web nega todo acesso dos agentes dela a fontes, bases,
   ferramentas e skills na hora, e os pedidos pendentes de aprovação deles caem.
2. Os agentes dela param (`podman stop`). A casa de cada um fica inteira: nada é apagado.
3. A memória de trabalho de cada agente (`MEMORY.md`, `working-memory.md`, `memory/*.md`) é copiada para a
   base de conhecimento `entrega-<pessoa>`, no escopo do **primeiro grupo** da pessoa (ou da empresa, se ela
   não tem grupo), com dono root e permissão 600/700. O sucessor, no mesmo grupo, consulta essa base pelo
   agente dele. A base `privada` da pessoa **não** é copiada nem exposta. Se o nome da pessoa é longo demais
   para o nome da base caber (40 caracteres), o comando recusa antes de mudar qualquer coisa e pede
   `--base <nome-curto>`. Se a base já estava no catálogo (por exemplo, o dono a estreitou para `privada`
   depois de um primeiro desligamento), ela fica como o dono deixou: só os arquivos são copiados de novo.
4. Para desfazer: `sudo dgclaw pessoa religar marta` e `sudo dgclaw agente iniciar <slug>` para cada agente.

O que fica fora, de propósito: as conversas (transcrições) não são copiadas, porque podem ter dado pessoal
de terceiros; se precisar delas, é decisão caso a caso. Apagar a casa do agente ou as transcrições é
outro passo, manual, que esta política não faz.

## O que o DG Claw não resolve

- O que a pessoa sabia e **nunca contou ao agente** não está em lugar nenhum. O registro só funciona se o
  trabalho passa pelo agente.
- Esta política não substitui contrato, aviso à pessoa nem a Lei Geral de Proteção de Dados. O
  `docs/SEGURANCA.md` diz que o DG Claw não promete conformidade; aqui também.
