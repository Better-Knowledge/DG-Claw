#!/usr/bin/env bash
# lib/bases.sh: leitura e escrita do /etc/dgclaw/bases.json, o catalogo das bases de conhecimento
# (web/docs/BASES-DE-CONHECIMENTO.md), e das pastas delas em /var/lib/dgclaw/bases/<nome>.
#
# O Web le o catalogo e decide, pelo escopo de cada base e pelos papeis (papeis.json), o que cada
# agente alcanca. Quem escreve o catalogo e o `dgclaw base criar|remover` (e o instalador, que so
# cria o arquivo vazio quando ele nao existe). Mesmo padrao do agentes.json: com trava, escrita
# atomica, root e modo 600. Precisa de lib/comum.sh carregado antes, e do jq.

# bases_garantir_arquivo: cria o bases.json vazio (e a pasta das bases) se ainda nao existem.
# Arquivo que ja existe e do dono: nunca e reescrito.
bases_garantir_arquivo() {
    if [ ! -s "$DG_BASES_JSON" ]; then
        printf '{"versao": 1, "bases": {}}\n' | escrever_arquivo "$DG_BASES_JSON" 600
    fi
    if [ ! -d "$DG_BASES_DIR" ]; then
        if [ "$ENSAIO" = 1 ]; then printf '   [ensaio] criaria a pasta %s (modo 700)\n' "$DG_BASES_DIR"; return 0; fi
        mkdir -p "$DG_BASES_DIR" && chmod 700 "$DG_BASES_DIR"
    fi
}

bases_ler() {
    if [ -s "$DG_BASES_JSON" ]; then cat "$DG_BASES_JSON"; else printf '{"versao": 1, "bases": {}}\n'; fi
}

# bases_obter <nome>: imprime o objeto da base, ou nada.
bases_obter() {
    bases_ler | jq -c --arg n "$1" '.bases[$n] // empty'
}

# A copia do DG Claw de onde vem o validador do Web: APP_DIR no dgclaw, SCRIPT_DIR no instalador.
BASES_APP="${APP_DIR:-${SCRIPT_DIR:-/opt/dgclaw/app}}"

# _bases_validar <json>: passa o catalogo pelo MESMO validador que o Web usa (web/lib/bases.js). Um catalogo
# invalido fecha TODAS as bases para todos os agentes, entao nada e gravado se ele nao passar. Sem node, falha
# (fechado), em vez de gravar sem conferir.
_bases_validar() {
    local erro_val
    command -v node >/dev/null 2>&1 || falha "preciso do node para conferir o catalogo de bases antes de gravar." "instale o node (o instalador do DG Claw faz isso) e rode de novo; nada foi gravado"
    erro_val="$(printf '%s' "$1" | node -e '
        const { validaBases } = require(process.argv[1]);
        let t = ""; process.stdin.on("data", (c) => { t += c; }).on("end", () => {
          const r = validaBases(JSON.parse(t)); if (!r.ok) { process.stdout.write(r.erros.join(" ")); process.exit(1); } });' "$BASES_APP/web/lib/bases.js" 2>&1)" \
        || falha "o catalogo de bases ficaria invalido (e um catalogo invalido fecha todas as bases): $erro_val" "nada foi gravado; confira ${DG_BASES_JSON#"${R:-}"}"
}

_bases_aplicar() {
    local filtro="$1"; shift
    local novo
    novo="$(bases_ler | jq "$@" "$filtro")" \
        || falha "nao consegui atualizar $DG_BASES_JSON (o jq recusou o conteudo atual)." \
                 "confira se o arquivo e um JSON valido com: jq . $DG_BASES_JSON"
    _bases_validar "$novo"
    printf '%s\n' "$novo" | escrever_arquivo "$DG_BASES_JSON" 600
}

# bases_registrar <nome> <objeto JSON>: grava (ou substitui) a base no catalogo. Quem nao quer substituir uma
# entrada que ja existe confere antes com bases_obter.
bases_registrar() {
    # shellcheck disable=SC2016 # $n e $o sao variaveis do jq
    com_trava _bases_aplicar '.bases[$n] = $o' --arg n "$1" --argjson o "$2"
}

# bases_remover <nome>: tira a base do catalogo (a pasta e tratada por quem chama).
bases_remover() {
    # shellcheck disable=SC2016
    com_trava _bases_aplicar 'del(.bases[$n])' --arg n "$1"
}
