#!/usr/bin/env bash
# dgclaw colaborador listar|convidar|agentes|reenviar|revogar: o mesmo arquivo, a mesma regra e a mesma trava do Web.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

HASH='scrypt$1024$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
printf "DGCLAW_PANEL_USER=dono@x.com\nDGCLAW_PANEL_PASSWORD_HASH='%s'\nOUTRA=1\n" "$HASH" >"$ETC/web.env"
chmod 600 "$ETC/web.env"
criar_agente ana --nome "Ana"
criar_agente bia --nome "Bia"
ARQ="$LIB/web/colaboradores.json"

echo "listar vazio"
dgclaw colaborador listar >"$TMP/l0.txt" 2>&1
afirma "sem ninguem, diz que nao ha convidados" grep -q 'nenhum colaborador' "$TMP/l0.txt"

echo "convidar"
dgclaw colaborador convidar Maria@X.com --agentes ana --nome "Maria" >"$TMP/c.txt" 2>"$TMP/c.err"
afirma "convidar maria" test $? -eq 0
afirma "imprime o link de login com o dominio e o e-mail" grep -q 'https://teste\.exemplo\.org/login?usuario=maria%40x\.com' "$TMP/c.txt"
afirma "imprime a senha temporaria uma vez" grep -qE '^Senha temporaria: [A-Za-z0-9]{12}$' "$TMP/c.txt"
afirma "cita o agente pelo nome" grep -q 'conversar com Ana no DG Claw' "$TMP/c.txt"
SENHA="$(sed -n 's/^Senha temporaria: //p' "$TMP/c.txt")"
afirma "o arquivo nasceu 600" test "$(stat -c %a "$ARQ")" = 600
afirma "maria esta no arquivo com a ana, hash scrypt e a instancia" jq -e '.colaboradores[] | select(.email == "maria@x.com") | .agentes == ["ana"] and .agente == "ana" and (.hash | startswith("scrypt$")) and (.instancias.ana | length > 0) and .trocar_senha == true and .criado_por == "cli"' "$ARQ"
nega "a senha temporaria nao vai para o arquivo" grep -q "$SENHA" "$ARQ"
nega "o hash nao aparece na saida" grep -q 'scrypt' "$TMP/c.txt"
dgclaw colaborador listar >"$TMP/l.txt" 2>&1
afirma "listar mostra maria aguardando, com a ana" grep -qE '^maria@x\.com +Maria +aguardando_primeiro_acesso +ana +nunca' "$TMP/l.txt"
nega "e-mail repetido recusado" dgclaw colaborador convidar maria@x.com --agentes bia
nega "e-mail invalido recusado" dgclaw colaborador convidar sem-arroba --agentes ana
nega "o e-mail do dono e recusado" dgclaw colaborador convidar dono@x.com --agentes ana
nega "o Admin nao entra na lista" dgclaw colaborador convidar caio@x.com --agentes ana,admin
nega "agente inexistente recusado" dgclaw colaborador convidar caio@x.com --agentes zed
nega "sem --agentes recusado" dgclaw colaborador convidar caio@x.com
afirma "so a maria no arquivo" test "$(jq '.colaboradores | length' "$ARQ")" = 1

echo "agentes"
afirma "troca os agentes" dgclaw colaborador agentes maria@x.com ana,bia
afirma "ficou com ana e bia" jq -e '.colaboradores[] | select(.email == "maria@x.com") | .agentes == ["ana", "bia"] and (.instancias.bia | length > 0)' "$ARQ"
nega "lista vazia e recusada (para tirar tudo, revogar)" dgclaw colaborador agentes maria@x.com ""
nega "e-mail desconhecido recusado" dgclaw colaborador agentes zeca@x.com ana
jq '.comentario = "do dono"' "$ARQ" >"$TMP/x.json" && cat "$TMP/x.json" >"$ARQ"
afirma "grava com o comentario alheio no arquivo" dgclaw colaborador agentes maria@x.com ana
afirma "o comentario alheio do arquivo sobrevive" jq -e '.comentario == "do dono"' "$ARQ"

echo "ensaio e trava"
afirma "--ensaio responde" dgclaw --ensaio colaborador convidar zeca@x.com --agentes ana
nega "--ensaio nao grava" jq -e '.colaboradores[] | select(.email == "zeca@x.com")' "$ARQ"
mkdir "$ARQ.trava"
nega "com a trava do Web ocupada, a CLI recusa em vez de gravar por cima" dgclaw colaborador agentes maria@x.com ana,bia
afirma "e nao alterou o arquivo" jq -e '.colaboradores[] | select(.email == "maria@x.com") | .agentes == ["ana"]' "$ARQ"
rmdir "$ARQ.trava"

echo "reenviar e revogar"
dgclaw colaborador reenviar maria@x.com >"$TMP/r.txt" 2>&1
afirma "reenviar" test $? -eq 0
afirma "senha nova impressa" grep -qE '^Senha temporaria: [A-Za-z0-9]{12}$' "$TMP/r.txt"
afirma "a versao da senha subiu" jq -e '.colaboradores[] | select(.email == "maria@x.com") | .senha_versao == 2' "$ARQ"
afirma "revogar" dgclaw colaborador revogar maria@x.com
afirma "revogado_em gravado, registro mantido" jq -e '.colaboradores[] | select(.email == "maria@x.com") | .revogado_em != null' "$ARQ"
nega "revogar duas vezes recusado" dgclaw colaborador revogar maria@x.com
nega "agentes de revogado recusado" dgclaw colaborador agentes maria@x.com ana
afirma "convidar o mesmo e-mail de novo cria registro novo" dgclaw colaborador convidar maria@x.com --agentes bia
afirma "dois registros, um revogado" test "$(jq '.colaboradores | length' "$ARQ")" = 2
dgclaw colaborador listar >"$TMP/l2.txt" 2>&1
afirma "listar mostra o revogado" grep -q 'revogado' "$TMP/l2.txt"
afirma "listar mostra o novo, sem nome, com a bia" grep -qE 'maria@x\.com +- +aguardando_primeiro_acesso +bia' "$TMP/l2.txt"
echo "ajuda"
dgclaw --ajuda >"$TMP/ajuda.txt" 2>&1
afirma "a ajuda documenta dgclaw colaborador convidar" grep -q 'dgclaw colaborador convidar' "$TMP/ajuda.txt"
nega "subcomando desconhecido" dgclaw colaborador xpto

fim
