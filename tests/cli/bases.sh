#!/usr/bin/env bash
# dgclaw base criar|listar|remover: o catalogo /etc/dgclaw/bases.json e as pastas em /var/lib/dgclaw/bases.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

CAT="$ETC/bases.json"
BASES="$LIB/bases"

echo "criar"
afirma "cria uma base da empresa" dgclaw base criar manual-rh --escopo empresa --nome "Manual do RH" --dono rh --classificacao interno --finalidade "procedimentos" --retencao 0
afirma "catalogo existe com 600" test "$(stat -c %a "$CAT")" = 600
afirma "pasta da base com 700" test "$(stat -c %a "$BASES/manual-rh")" = 700
igual "escopo gravado" "empresa" "$(jq -r '.bases["manual-rh"].escopo' "$CAT")"
igual "titulo gravado" "Manual do RH" "$(jq -r '.bases["manual-rh"].nome' "$CAT")"
igual "retencao como numero" "0" "$(jq -r '.bases["manual-rh"].retencao_dias' "$CAT")"
afirma "cria uma base de grupo" dgclaw base criar contratos-x --escopo grupo:projeto-x --classificacao sensivel
igual "grupo gravado" "projeto-x" "$(jq -r '.bases["contratos-x"].grupo' "$CAT")"
igual "escopo grupo" "grupo" "$(jq -r '.bases["contratos-x"].escopo' "$CAT")"
afirma "cria uma base privada" dgclaw base criar notas-marta --escopo pessoa:marta
igual "pessoa gravada" "marta" "$(jq -r '.bases["notas-marta"].pessoa' "$CAT")"
igual "escopo privada" "privada" "$(jq -r '.bases["notas-marta"].escopo' "$CAT")"
nega "campos nao pedidos nao aparecem" jq -e '.bases["notas-marta"] | has("grupo") or has("dono")' "$CAT"

echo "rodar de novo atualiza sem apagar a pasta"
printf '# Ferias\n' >"$BASES/manual-rh/ferias.md"
afirma "criar de novo com outro titulo" dgclaw base criar manual-rh --escopo empresa --nome "Manual do RH v2"
igual "titulo atualizado" "Manual do RH v2" "$(jq -r '.bases["manual-rh"].nome' "$CAT")"
afirma "o arquivo da pasta continua" test -f "$BASES/manual-rh/ferias.md"
igual "tres bases no catalogo" "3" "$(jq '.bases | length' "$CAT")"

echo "validacao"
nega "nome com maiuscula recusado" dgclaw base criar Manual --escopo empresa
nega "nome com barra recusado" dgclaw base criar "a/b" --escopo empresa
nega "sem escopo recusado" dgclaw base criar x
nega "escopo inexistente recusado" dgclaw base criar x --escopo todos
nega "grupo invalido recusado" dgclaw base criar x --escopo "grupo:Projeto X"
nega "classificacao invalida recusada" dgclaw base criar x --escopo empresa --classificacao ultra
nega "retencao nao numerica recusada" dgclaw base criar x --escopo empresa --retencao muito
nega "opcao desconhecida recusada" dgclaw base criar x --escopo empresa --cor azul
nega "retencao acima de 36500 recusada (o Web recusaria o catalogo inteiro)" dgclaw base criar x --escopo empresa --retencao 99999
nega "titulo com tab recusado" dgclaw base criar x --escopo empresa --nome $'a\tb'
nega "titulo so de espacos recusado" dgclaw base criar x --escopo empresa --nome "   "
nega "titulo de 121 bytes recusado" dgclaw base criar x --escopo empresa --nome "$(printf 'a%.0s' $(seq 1 121))"
nega "finalidade com caractere de controle recusada" dgclaw base criar x --escopo empresa --finalidade $'ok\x01'
igual "nada disso entrou no catalogo" "3" "$(jq '.bases | length' "$CAT")"
dgclaw base criar "a;b" --escopo empresa >"$TMP/o.txt" 2>&1
afirma "a recusa diz o que fazer" grep -q "exemplo: manual-rh" "$TMP/o.txt"

echo "o catalogo gravado passa no validador do Web"
afirma "validaBases aceita o catalogo da CLI" node -e "const {validaBases}=require('$REPO/web/lib/bases.js'); const r=validaBases(JSON.parse(require('fs').readFileSync('$CAT','utf8'))); if(!r.ok){console.error(r.erros);process.exit(1)}"

echo "listar"
igual "listar --json devolve 3" "3" "$(dgclaw base listar --json | jq length)"
igual "conta os arquivos da pasta" "1" "$(dgclaw base listar --json | jq '.[] | select(.nome == "manual-rh") | .arquivos')"
afirma "tabela legivel traz o escopo" bash -c "'$CLI' base listar | grep -q 'projeto-x'"
nega "opcao desconhecida no listar" dgclaw base listar --tudo

echo "ensaio"
afirma "ensaio nao grava" dgclaw --ensaio base criar ensaio --escopo publica
nega "ensaio nao entrou no catalogo" jq -e '.bases["ensaio"]' "$CAT"
nega "ensaio nao criou pasta" test -d "$BASES/ensaio"

echo "remover"
nega "sem --sim e sem terminal recusa" dgclaw base remover manual-rh
afirma "ainda no catalogo" jq -e '.bases["manual-rh"]' "$CAT"
afirma "remover --sim" dgclaw base remover manual-rh --sim
nega "saiu do catalogo" jq -e '.bases["manual-rh"]' "$CAT"
nega "a pasta saiu do lugar" test -e "$BASES/manual-rh"
apos="$(find "$LIB/bases-aposentadas" -maxdepth 1 -name 'manual-rh-*' | head -1)"
afirma "a pasta foi para bases-aposentadas/manual-rh-<data>" test -f "$apos/ferias.md"
afirma "as outras bases ficaram" jq -e '.bases["contratos-x"] and .bases["notas-marta"]' "$CAT"
nega "remover base inexistente recusa" dgclaw base remover fantasma --sim
afirma "remover base sem pasta funciona" bash -c "rm -rf '$BASES/notas-marta' && '$CLI' base remover notas-marta --sim"
nega "'base nada' recusado" dgclaw base nada
nega "'base' sem subcomando recusado" dgclaw base

echo "ajuda"
dgclaw --ajuda >"$TMP/ajuda.txt" 2>&1
afirma "a ajuda documenta dgclaw base criar" grep -q 'dgclaw base criar' "$TMP/ajuda.txt"
fim
