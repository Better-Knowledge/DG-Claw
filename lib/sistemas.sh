#!/usr/bin/env bash
# lib/sistemas.sh: o cofre de sistemas (/etc/dgclaw/cofre-sistemas/<nome>, root, 600) e o catalogo de
# ferramentas (/etc/dgclaw/ferramentas.json, root, 600). web/docs/FERRAMENTAS-POR-ESCOPO.md.
#
# Uma credencial por SISTEMA (CRM, ERP, servidor MCP), nunca por agente: o Web a le na hora da chamada e a
# injeta; o agente nunca a recebe. O valor vem SEMPRE pelo STDIN (nunca em argv: o `ps` mostra argv).
# Precisa de lib/comum.sh carregado antes.

# sistemas_garantir_arquivos: cria o catalogo vazio e a pasta do cofre se ainda nao existem.
# Arquivo que ja existe e do dono: nunca e reescrito.
sistemas_garantir_arquivos() {
    if [ ! -s "$DG_FERRAMENTAS_JSON" ]; then
        printf '{"versao": 1, "ferramentas": {}}\n' | escrever_arquivo "$DG_FERRAMENTAS_JSON" 600
    fi
    if [ ! -d "$DG_COFRE_SISTEMAS" ]; then
        if [ "$ENSAIO" = 1 ]; then printf '   [ensaio] criaria a pasta %s (modo 700)\n' "$DG_COFRE_SISTEMAS"; return 0; fi
        mkdir -p "$DG_COFRE_SISTEMAS" && chmod 700 "$DG_COFRE_SISTEMAS"
    fi
}

# sistemas_credencial_gravar <nome>: le o valor do STDIN e grava em <cofre>/<nome> (root, 600), atomicamente.
sistemas_credencial_gravar() {
    local nome="$1" valor tmp
    [[ "$nome" =~ ^[a-z][a-z0-9_-]{0,39}$ ]] || falha "o nome '$nome' nao serve: use de 1 a 40 caracteres entre letras minusculas, numeros, _ e -, comecando por letra." "exemplo: crm, notion, erp-financeiro"
    [ ! -t 0 ] || falha "o valor da credencial vem pelo STDIN, nunca na linha de comando." "exemplo: printf %s \"\$VALOR\" | sudo dgclaw sistema credencial $nome"
    valor="$(cat)"
    valor="${valor%$'\n'}"
    [ -n "$valor" ] || falha "a credencial veio vazia." "mande o valor pelo STDIN: printf %s \"\$VALOR\" | sudo dgclaw sistema credencial $nome"
    [ "${#valor}" -le 8000 ] || falha "a credencial passa de 8000 caracteres." "confira se mandou o valor certo"
    case "$valor" in *$'\n'*) falha "a credencial tem quebra de linha no meio." "mande so o valor, numa linha" ;; esac
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] gravaria a credencial $nome em ${DG_COFRE_SISTEMAS#"$R"}/$nome (modo 600, dono root)"; return 0; fi
    sistemas_garantir_arquivos
    tmp="$(mktemp "$DG_COFRE_SISTEMAS/.$nome.XXXXXX")"
    printf '%s\n' "$valor" > "$tmp"
    chmod 600 "$tmp"
    mv -f "$tmp" "$DG_COFRE_SISTEMAS/$nome"
}

# sistemas_credencial_remover <nome>
sistemas_credencial_remover() {
    local nome="$1"
    [[ "$nome" =~ ^[a-z][a-z0-9_-]{0,39}$ ]] || falha "o nome '$nome' nao e valido." "veja os nomes com: dgclaw sistema listar"
    [ -f "$DG_COFRE_SISTEMAS/$nome" ] || falha "nao ha credencial '$nome' no cofre de sistemas." "veja os nomes com: dgclaw sistema listar"
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] apagaria ${DG_COFRE_SISTEMAS#"$R"}/$nome"; return 0; fi
    rm -f "$DG_COFRE_SISTEMAS/$nome"
}

# sistemas_credenciais_nomes: imprime os nomes (nunca valores), um por linha.
sistemas_credenciais_nomes() {
    [ -d "$DG_COFRE_SISTEMAS" ] || return 0
    find "$DG_COFRE_SISTEMAS" -maxdepth 1 -type f -printf '%f\n' 2>/dev/null | grep -E '^[a-z][a-z0-9_-]{0,39}$' | sort
}
