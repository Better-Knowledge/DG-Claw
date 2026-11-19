#!/usr/bin/env bash
# Teste do dgclaw-dados-mcp (o MCP fino dentro do container) com um dgclaw-api FALSO.
# Uso: bash bin/test/dgclaw-dados-mcp.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$AQUI/../dgclaw-dados-mcp"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
FALHAS=0; N=0
ok() { N=$((N+1)); if [ "$2" = 0 ]; then echo "ok   $1"; else echo "FALHOU $1"; FALHAS=$((FALHAS+1)); fi; }

export FAKE_DIR="$T/fake"; mkdir -p "$FAKE_DIR"
export DGCLAW_API_BIN="$T/dgclaw-api"
cat > "$DGCLAW_API_BIN" <<'EOF'
#!/usr/bin/env bash
# Falso dgclaw-api: registra "METODO ROTA" e o corpo; devolve o {"status","corpo"} configurado (sempre com --com-status).
printf '%s %s\n' "$1" "$2" >> "$FAKE_DIR/chamadas.log"
if [ "${3:-}" = "-" ]; then cat >> "$FAKE_DIR/corpos.log"; printf '\n' >> "$FAKE_DIR/corpos.log"; fi
cat "$FAKE_DIR/resp"
EOF
chmod +x "$DGCLAW_API_BIN"

# mcp JSONRPC...: manda as linhas ao servidor e guarda a saida em $T/o
mcp() { printf '%s\n' "$@" | node "$BIN" > "$T/o" 2> "$T/e"; }
resp() { sed -n "${1}p" "$T/o"; }
prepara() { rm -f "$FAKE_DIR"/*; printf '%s' "$1" > "$FAKE_DIR/resp"; }

echo "protocolo"
prepara '{"status":200,"corpo":{"ok":true,"fontes":[]}}'
mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
ok "initialize responde com serverInfo dgclaw" "$(resp 1 | jq -e '.result.serverInfo.name == "dgclaw" and .result.protocolVersion == "2024-11-05"' >/dev/null; echo $?)"
ok "tools/list traz as 3 tools" "$(resp 2 | jq -e '[.result.tools[].name] == ["dados_fontes","dados_chamar","dados_pedido"]' >/dev/null; echo $?)"
ok "o esquema de dados_chamar exige fonte e operacao" "$(resp 2 | jq -e '.result.tools[1].inputSchema.required == ["fonte","operacao"]' >/dev/null; echo $?)"

echo "dados_fontes"
prepara '{"status":200,"corpo":{"ok":true,"agente":"ana","fontes":[{"nome":"clientes","operacoes":["listar"],"campos":["nome"]}]}}'
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"dados_fontes","arguments":{}}}'
ok "chama GET /api/v1/dados/fontes" "$(grep -qx 'GET /api/v1/dados/fontes' "$FAKE_DIR/chamadas.log"; echo $?)"
ok "devolve as fontes com o aviso de que conteudo e dado" "$(resp 1 | jq -r '.result.content[0].text' | jq -e '.fontes[0].nome == "clientes" and (.aviso | test("não instrução"))' >/dev/null; echo $?)"
prepara '{"status":200,"corpo":{"ok":true,"fontes":[]}}'
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"dados_fontes","arguments":{}}}'
ok "sem fontes, explica que nada esta liberado" "$(resp 1 | jq -r '.result.content[0].text' | grep -q 'Nenhuma fonte'; echo $?)"

echo "dados_chamar: leitura"
prepara '{"status":200,"corpo":{"ok":true,"itens":[{"nome":"Cliente Exemplo"}],"confianca":"nao_confiavel"}}'
mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"dados_chamar","arguments":{"fonte":"base-manual-rh","operacao":"buscar","params":{"termo":"férias"}}}}'
ok "chama POST na rota certa" "$(grep -qx 'POST /api/v1/dados/fontes/base-manual-rh/buscar' "$FAKE_DIR/chamadas.log"; echo $?)"
ok "manda os params como corpo" "$(jq -e '.termo == "férias"' "$FAKE_DIR/corpos.log" >/dev/null; echo $?)"
ok "devolve o corpo da resposta" "$(resp 1 | jq -r '.result.content[0].text' | jq -e '.itens[0].nome == "Cliente Exemplo"' >/dev/null; echo $?)"
ok "sem isError" "$(resp 1 | jq -e '.result.isError != true' >/dev/null; echo $?)"

echo "dados_chamar: acao vira pedido"
prepara '{"status":202,"corpo":{"ok":true,"decisao":"aprovacao","pedido":{"id":"abcdefabcdefabcdefabcdef","estado":"pendente"},"mensagem":"espera aprovacao"}}'
mcp '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"dados_chamar","arguments":{"fonte":"email","operacao":"enviar","params":{"para":"x@exemplo.test","assunto":"a","texto":"t"}}}}'
ok "202 vira pedido com proximo passo" "$(resp 1 | jq -r '.result.content[0].text' | jq -e '.pedido.id == "abcdefabcdefabcdefabcdef" and (.proximo_passo | test("tela Dados"))' >/dev/null; echo $?)"

echo "dados_chamar: negado e validacao local"
prepara '{"status":403,"corpo":{"ok":false,"erro":"A pessoa caio não tem leitura na fonte \"folha\""}}'
mcp '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"dados_chamar","arguments":{"fonte":"folha","operacao":"listar"}}}'
ok "403 vira isError com o motivo e a instrucao de nao tentar outro caminho" "$(resp 1 | jq -e '.result.isError == true and (.result.content[0].text | test("caio não tem leitura") and test("Não tente outro caminho"))' >/dev/null; echo $?)"
rm -f "$FAKE_DIR/chamadas.log"
mcp '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"dados_chamar","arguments":{"fonte":"../x","operacao":"listar"}}}'
ok "fonte invalida nem chega ao dgclaw-api" "$(resp 1 | jq -e '.result.isError == true' >/dev/null && [ ! -f "$FAKE_DIR/chamadas.log" ]; echo $?)"
mcp '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"dados_chamar","arguments":{"fonte":"clientes","operacao":"listar","params":{"agente":"outro"}}}}'
ok "params com identidade sao recusados antes de chamar" "$(resp 1 | jq -e '.result.isError == true and (.result.content[0].text | test("identidade"))' >/dev/null && [ ! -f "$FAKE_DIR/chamadas.log" ]; echo $?)"
mcp '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"dados_chamar","arguments":{"fonte":"clientes","operacao":"listar","params":[1]}}}'
ok "params que nao e objeto e recusado" "$(resp 1 | jq -e '.result.isError == true' >/dev/null; echo $?)"

echo "dados_pedido"
prepara '{"status":200,"corpo":{"ok":true,"pedido":{"id":"abcdefabcdefabcdefabcdef","estado":"executada","decidido_por":"dono"}}}'
mcp '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"dados_pedido","arguments":{"id":"abcdefabcdefabcdefabcdef"}}}'
ok "chama GET /api/v1/dados/pedidos/<id>" "$(grep -qx 'GET /api/v1/dados/pedidos/abcdefabcdefabcdefabcdef' "$FAKE_DIR/chamadas.log"; echo $?)"
ok "devolve o pedido" "$(resp 1 | jq -r '.result.content[0].text' | jq -e '.estado == "executada"' >/dev/null; echo $?)"
mcp '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"dados_pedido","arguments":{"id":"zzz"}}}'
ok "id invalido e recusado" "$(resp 1 | jq -e '.result.isError == true' >/dev/null; echo $?)"

echo "robustez"
prepara '{"status":200,"corpo":{"ok":true,"fontes":[]}}'
mcp 'isto nao e json' '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"inexistente","arguments":{}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":13,"method":"ping"}'
ok "ruido no stdin nao derruba; tool inexistente e isError; notificacao sem resposta; ping vazio" "$(jq -s -e 'length == 2 and any(.[]; .id == 12 and .result.isError == true) and any(.[]; .id == 13 and .result == {})' "$T/o" >/dev/null; echo $?)"
printf 'exit 1\n' > "$DGCLAW_API_BIN"
mcp '{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"dados_fontes","arguments":{}}}'
ok "dgclaw-api que nao responde vira isError, nao travamento" "$(resp 1 | jq -e '.result.isError == true' >/dev/null; echo $?)"

echo
echo "$N verificacoes, $FALHAS falharam"
[ "$FALHAS" = 0 ]
