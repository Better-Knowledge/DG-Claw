# Observabilidade: quem leu o quê, quando e por qual agente

Toda chamada à rota de dados (fontes, bases de conhecimento, ferramentas, skills, aprovações) vira **uma linha
no log de acesso**, sem o conteúdo do dado e sem segredo (`web/docs/DADOS-POR-PAPEL.md`, "Log de acesso"). A
tela **Observabilidade** (menu ☰, ou `/observabilidade`) lê esse log para o dono:

- **Uso dos dados nos últimos 30 dias**: quantos pedidos, quantos permitidos, negados, aprovações pedidas,
  executadas, recusadas, falharam; as contagens por agente, por fonte e por pessoa; e **Sistemas de fora,
  por agente**: qual agente usou qual sistema (CRM, ERP, servidor MCP) com qual escopo.
- **Quem leu o quê**: linha a linha, com filtros por agente, pessoa, fonte, decisão e período, e o botão
  **Baixar CSV** com as mesmas linhas para a planilha.

## Rotas (só o dono, pelo painel)

| Rota | O que faz |
| --- | --- |
| `GET /api/v1/dados/log?limit=&agente=&pessoa=&fonte=&decisao=&operacao=&desde=&ate=` | as linhas, mais novas primeiro, até `limit` (padrão 100, máximo 1000); filtros por igualdade exata; datas `AAAA-MM-DD` |
| `GET /api/v1/dados/log.csv` (mesmos filtros; `limit` padrão 1000) | as linhas em CSV (UTF-8 com BOM, para o Excel abrir certo) |
| `GET /api/v1/dados/log/resumo?desde=` | contagens por decisão, agente, fonte, pessoa e `por_agente_sistema` ("agente › sistema (escopo)") desde a data (padrão: 30 dias), até 100 mil linhas |

Os campos de cada linha: `quando, agente, pessoa, papel, fonte, escopo, operacao, acao, decisao, motivo,
status, itens, bytes, aprovacao, por, credencial` (o **nome** da credencial que a chamada à ferramenta usou,
nunca o valor). `decisao` é `permitido`, `negado`, `aprovacao` (pedido criado),
`executada`, `recusada`, `falhou` ou `revogada`.

## O que a tela responde

- "Quem acessou os clientes esta semana?" filtre fonte `clientes` e desde a segunda-feira.
- "Algum agente está batendo em porta fechada?" decisão `negado`, veja o motivo.
- "O que o agente da Marta usou antes de ela sair?" pessoa `marta`, CSV para guardar.

## Limites

- O log guarda só o que passa pela rota de dados. O que o agente alcança por outro caminho (canal, rede,
  arquivo montado) não aparece aqui; o `docs/SEGURANCA.md` lista o que fica fora.
- Retenção de `DGCLAW_DADOS_LOG_DIAS` dias (padrão 90) no `web.env`; o resumo lê no máximo 100 mil linhas.
- Não há alerta automático nesta versão: a tela mostra, a pessoa decide. Alertas (por exemplo, "mais de N
  negados por hora") são a próxima etapa.
