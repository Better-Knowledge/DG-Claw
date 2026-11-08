#!/usr/bin/env bash
# dgclaw sistema credencial|listar|remover: o cofre de sistemas (/etc/dgclaw/cofre-sistemas) e o catalogo de ferramentas.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

COFRE="$ETC/cofre-sistemas"
CAT="$ETC/ferramentas.json"

echo "credencial"
afirma "guarda pelo STDIN" bash -c "printf %s 'segredo-crm-123' | '$CLI' sistema credencial crm"
afirma "pasta do cofre com 700" test "$(stat -c %a "$COFRE")" = 700
afirma "arquivo com 600" test "$(stat -c %a "$COFRE/crm")" = 600
igual "o valor gravado, com quebra de linha final" "segredo-crm-123" "$(cat "$COFRE/crm")"
afirma "catalogo nasceu vazio e com 600" bash -c "[ \"\$(stat -c %a '$CAT')\" = 600 ] && jq -e '.versao == 1 and (.ferramentas | length) == 0' '$CAT'"
afirma "regravar substitui" bash -c "printf 'novo\n' | '$CLI' sistema credencial crm"
igual "valor novo sem a quebra duplicada" "novo" "$(cat "$COFRE/crm")"
nega "nome com maiuscula recusado" bash -c "printf x | '$CLI' sistema credencial CRM"
nega "nome com barra recusado" bash -c "printf x | '$CLI' sistema credencial 'a/b'"
nega "valor vazio recusado" bash -c "printf '' | '$CLI' sistema credencial erp"
nega "valor com quebra no meio recusado" bash -c "printf 'a\nb' | '$CLI' sistema credencial erp"
nega "valor na linha de comando recusado" bash -c "printf x | '$CLI' sistema credencial erp valor-aqui"
nega "sem stdin (terminal) recusado" bash -c "'$CLI' sistema credencial erp < /dev/tty" 2>/dev/null || true
nega "nada disso criou arquivo" test -e "$COFRE/erp"
"$CLI" sistema credencial 'a;b' < /dev/null >"$TMP/o.txt" 2>&1
afirma "a recusa diz o que fazer" grep -q 'exemplo: crm' "$TMP/o.txt"
nega "o valor nunca aparece na saida" grep -q 'segredo-crm-123' "$TMP/o.txt"

echo "listar"
afirma "guarda uma segunda" bash -c "printf %s 'tok' | '$CLI' sistema credencial notion"
dgclaw sistema listar >"$TMP/l.txt" 2>&1
afirma "lista os nomes" bash -c "grep -q '^  crm$' '$TMP/l.txt' && grep -q '^  notion$' '$TMP/l.txt'"
nega "nunca os valores" bash -c "grep -q 'novo\|tok' '$TMP/l.txt'"
afirma "diz que o catalogo esta vazio" grep -q 'nenhuma; edite o catalogo' "$TMP/l.txt"
printf '{"versao":1,"ferramentas":{"crm":{"tipo":"api","base_url":"https://a.test","credencial":"crm","auth":{"tipo":"bearer"},"operacoes":{"listar":{"metodo":"GET","rota":"/c","escopo":"crm:ler"}}}}}\n' >"$CAT"
dgclaw sistema listar >"$TMP/l.txt" 2>&1
afirma "lista a ferramenta com tipo, credencial e contagem" grep -qE '^  crm +api +crm +1$' "$TMP/l.txt"
printf '{ quebrado' >"$CAT"
dgclaw sistema listar >"$TMP/l.txt" 2>&1
afirma "catalogo invalido e dito, nao escondido" grep -q 'nao e um JSON valido' "$TMP/l.txt"

echo "ensaio"
afirma "ensaio nao grava" bash -c "printf x | '$CLI' --ensaio sistema credencial ensaio"
nega "ensaio nao criou arquivo" test -e "$COFRE/ensaio"

echo "remover"
afirma "remover apaga" dgclaw sistema remover notion
nega "arquivo sumiu" test -e "$COFRE/notion"
afirma "a outra ficou" test -f "$COFRE/crm"
nega "remover inexistente recusa" dgclaw sistema remover fantasma
nega "'sistema nada' recusado" dgclaw sistema nada
nega "'sistema' sem subcomando recusado" dgclaw sistema

echo "ajuda"
dgclaw --ajuda >"$TMP/ajuda.txt" 2>&1
afirma "a ajuda documenta dgclaw sistema credencial" grep -q 'dgclaw sistema credencial' "$TMP/ajuda.txt"
fim
