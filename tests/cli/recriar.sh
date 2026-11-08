#!/usr/bin/env bash
# `dgclaw agente recriar`: a troca do container nao pode travar num container preso em "stopping".
# Cobre: parada com espera, "stopping" que passa sozinho, "stopping" para sempre (rm -f so do
# container), volume do podman (nao usa -f), estados exited/ausente com --forcar, e a mensagem de
# erro que diz a verdade sobre o que foi ou nao removido.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar
export DGCLAW_TEMPO_PARADA=3   # espera de 3 s em vez de 90 s, para o teste ser rapido

criar_agente ana --nome "Ana"
criar_agente beto --nome "Beto"
echo imagem-v2 >"$STUB_ESTADO/imagem-id"   # a imagem mudou: o container precisa ser recriado

recriar() { : >"$STUB_LOG"; dgclaw agente recriar "$@" >"$TMP/rec.txt" 2>&1; }

echo "parada normal"
recriar ana
igual "recriar sai com 0" "0" "$?"
afirma "para com -t 60" grep -q '^podman stop -t 60 dgclaw-ana' "$STUB_LOG"
afirma "remove com rm normal (sem -f)" grep -q '^podman rm dgclaw-ana' "$STUB_LOG"
nega "nao usou rm -f" grep -q '^podman rm -f' "$STUB_LOG"
afirma "criou o container de novo" grep -q '^podman create .*--name dgclaw-ana ' "$STUB_LOG"

echo "stop devolve mas o estado fica 'stopping' por algumas consultas"
echo imagem-v3 >"$STUB_ESTADO/imagem-id"
echo 2 >"$STUB_ESTADO/stop-trava-dgclaw-ana"
recriar ana
igual "espera o estado sair de stopping e termina com 0" "0" "$?"
afirma "esperou e usou rm normal" grep -q '^podman rm dgclaw-ana' "$STUB_LOG"
nega "nao precisou de rm -f" grep -q '^podman rm -f' "$STUB_LOG"
rm -f "$STUB_ESTADO/stop-trava-dgclaw-ana"

echo "stopping para sempre: rm -f so do container"
echo imagem-v4 >"$STUB_ESTADO/imagem-id"
echo sempre >"$STUB_ESTADO/stop-trava-dgclaw-ana"
casa_antes="$(find "$LIB/agentes/ana" -type f | sort | xargs sha256sum | sha256sum)"
recriar ana
igual "termina com 0 usando rm -f" "0" "$?"
afirma "usou podman rm -f no container do agente" grep -q '^podman rm -f dgclaw-ana' "$STUB_LOG"
afirma "avisou por que usa -f" grep -q "continua em 'stopping'" "$TMP/rec.txt"
nega "nenhum volume foi removido" grep -q '^podman volume' "$STUB_LOG"
igual "a casa do agente ficou intacta" "$casa_antes" "$(find "$LIB/agentes/ana" -type f | sort | xargs sha256sum | sha256sum)"
afirma "container novo no ar" grep -qx running "$STUB_ESTADO/c-dgclaw-ana"

echo "stopping para sempre + volume do podman: nao usa -f e explica"
echo imagem-v5 >"$STUB_ESTADO/imagem-id"
touch "$STUB_ESTADO/mounts-volume"
recriar ana
nega "falha" test "$?" -eq 0
nega "nao usou rm -f" grep -q '^podman rm -f' "$STUB_LOG"
afirma "explica o volume" grep -q 'volume do podman' "$TMP/rec.txt"
afirma "diz que o container antigo continua la, em stopping" grep -q 'ANTIGO do agente ana continua la, no estado stopping' "$TMP/rec.txt"
nega "nao diz 'foi removido'" grep -q 'foi removido e o novo NAO' "$TMP/rec.txt"
afirma "diz o comando para tentar de novo" grep -q 'dgclaw agente recriar ana --forcar' "$TMP/rec.txt"
rm -f "$STUB_ESTADO/mounts-volume"

echo "sem --forcar, 'stopping' e a troca que travou: recria"
recriar ana
igual "recria e termina com 0" "0" "$?"
afirma "avisa que estava preso em stopping" grep -q "preso em 'stopping'" "$TMP/rec.txt"
rm -f "$STUB_ESTADO/stop-trava-dgclaw-ana"
afirma "container novo no ar" grep -qx running "$STUB_ESTADO/c-dgclaw-ana"

echo "agente desligado (exited)"
echo exited >"$STUB_ESTADO/c-dgclaw-beto"
recriar beto
igual "sem --forcar deixa como esta (0)" "0" "$?"
afirma "diz que deixou como esta e oferece --forcar" grep -q 'deixei como esta.*--forcar' "$TMP/rec.txt"
nega "nao mexeu no container" grep -q '^podman \(stop\|rm\|create\)' "$STUB_LOG"
recriar beto --forcar
igual "com --forcar recria (0)" "0" "$?"
afirma "removeu o container parado sem stop" bash -c "grep -q '^podman rm dgclaw-beto' '$STUB_LOG' && ! grep -q '^podman stop' '$STUB_LOG'"
afirma "criou de novo" grep -q '^podman create .*--name dgclaw-beto ' "$STUB_LOG"

echo "container ausente com --forcar: cria do zero com os mesmos volumes e portas"
rm -f "$STUB_ESTADO/c-dgclaw-beto"
porta="$(awk -F'\t' '$1 == "beto" {print $0}' "$ETC/portas.tsv" | head -n1)"
recriar beto --forcar
igual "recria (0)" "0" "$?"
afirma "criou com a casa do Beto" grep -q "^podman create .*--name dgclaw-beto .*--volume $LIB/agentes/beto/home:/home/agente:rw" "$STUB_LOG"
afirma "criou com as portas do registro" grep -q -- '--publish 127.0.0.1:[0-9]*:4300' "$STUB_LOG"
nega "nao tentou parar nem remover o que nao existe" grep -q '^podman \(stop\|rm\) ' "$STUB_LOG"
: "$porta"


echo "recriar e reparar entregam o MCP de dados a um agente que nasceu sem ele"
MCP="$LIB/agentes/ana/home/.plataforma/dgchat.mcp.json"
RJ="$LIB/agentes/ana/runner/runner.json"
jq 'del(.mcpServers.dgclaw)' "$MCP" > "$TMP/mcp.json" && cp "$TMP/mcp.json" "$MCP"
jq '.config.allowTools = ["mcp__dgchat__reply"]' "$RJ" > "$TMP/rj.json" && cp "$TMP/rj.json" "$RJ"
printf '{"versao":1}\n' > "$LIB/agentes/ana/home/.plataforma/extra.json"
echo imagem-nova-2 > "$STUB_ESTADO/imagem-id"
recriar ana
igual "recriar sai com 0" "0" "$?"
afirma "o dgchat.mcp.json ganhou o servidor dgclaw" jq -e '.mcpServers.dgclaw.args[0] == "/opt/dgclaw/app/bin/dgclaw-dados-mcp" and .mcpServers.dgchat.command == "node"' "$MCP"
afirma "o runner.json ganhou as tres allowTools sem perder a que ja tinha" jq -e '.config.allowTools == ["mcp__dgchat__reply","mcp__dgclaw__dados_fontes","mcp__dgclaw__dados_chamar","mcp__dgclaw__dados_pedido"]' "$RJ"
afirma "runner.json continua 444 e do root" test "$(stat -c '%a %u' "$RJ")" = "444 0"
cp "$MCP" "$TMP/mcp-antes"; cp "$RJ" "$TMP/rj-antes"
recriar ana --forcar
afirma "rodar de novo nao duplica nada" bash -c "cmp -s '$MCP' '$TMP/mcp-antes' && cmp -s '$RJ' '$TMP/rj-antes'"
jq 'del(.mcpServers.dgclaw)' "$MCP" > "$TMP/mcp.json" && cp "$TMP/mcp.json" "$MCP"
dgclaw agente reparar ana >"$TMP/rep.txt" 2>&1
igual "reparar sai com 0" "0" "$?"
afirma "reparar tambem poe o servidor dgclaw" jq -e '.mcpServers.dgclaw' "$MCP"
printf '{ quebrado' > "$MCP"
dgclaw agente reparar ana >"$TMP/rep.txt" 2>&1
igual "mcp.json quebrado: reparar avisa e nao derruba" "0" "$?"
afirma "o aviso cita o arquivo" grep -q 'nao e um JSON valido com mcpServers' "$TMP/rep.txt"
igual "o arquivo quebrado nao foi sobrescrito" "{ quebrado" "$(cat "$MCP")"
# agente parado e imagem ja atual: o recriar nao troca o container, mas os arquivos ganham o MCP mesmo assim
jq 'del(.mcpServers.dgclaw)' "$TMP/mcp-antes" > "$MCP"
dgclaw agente parar ana >/dev/null 2>&1
recriar ana
igual "recriar de agente parado sai com 0" "0" "$?"
afirma "mesmo sem trocar o container, o mcp.json ganhou o servidor dgclaw" jq -e '.mcpServers.dgclaw' "$MCP"
# atalho no lugar do mcp.json: root nao segue; avisa e nao mexe
rm -f "$MCP"; printf '{"mcpServers":{"x":{}},"SEGREDO_DO_ALVO":1}\n' > "$TMP/alvo.json"; ln -s "$TMP/alvo.json" "$MCP"
recriar ana --forcar
afirma "atalho: o aviso aparece" grep -q 'e um atalho; nao mexo' "$TMP/rec.txt"
afirma "atalho: continua atalho e o alvo nao mudou" bash -c "[ -L '$MCP' ] && ! grep -q dgclaw '$TMP/alvo.json'"
rm -f "$MCP"; cp "$TMP/mcp-antes" "$MCP"
fim
