#!/usr/bin/env bash
# lib/colaboradores.sh: os colaboradores do painel pela CLI (dgclaw colaborador ...), para o Admin fazer pelo chat o que
# a tela /colaboradores faz. O arquivo e o mesmo do Web (<dados do Web>/colaboradores.json) e quem mexe nele e o
# proprio codigo do Web (web/lib/colaboradores.js), por web/lib/colaboradores-cli.js: mesma regra, mesma trava, nenhum
# hash impresso. O Web rele o arquivo sozinho quando ele muda. Precisa de lib/comum.sh carregado antes, de jq e de node.

COLAB_APP="${APP_DIR:-${SCRIPT_DIR:-/opt/dgclaw/app}}"
COLAB_WEB_ENV="${DGCLAW_WEB_ENV:-$DG_ETC/web.env}"
# Pasta de dados e registro: o que vier do ambiente; senao "-", e a ponte le do web.env com o MESMO parser do Web.
COLAB_DATA="${DGCLAW_WEB_DATA:--}"
COLAB_AGENTES="${DGCLAW_AGENTES:--}"

# _colab_node <acao> [json]: roda a ponte e imprime o JSON; falha com a mensagem do Web.
_colab_node() {
    local acao="$1" json="${2:-}" saida erro
    [ -f "$COLAB_WEB_ENV" ] || falha "nao achei $COLAB_WEB_ENV." "o DG Claw Web ainda nao foi instalado; rode o instalador: sudo ./install.sh --usuario <nome>"
    erro="$(mktemp)"
    if saida="$(node "$COLAB_APP/web/lib/colaboradores-cli.js" "$COLAB_DATA" "$COLAB_WEB_ENV" "$COLAB_AGENTES" "$acao" "$json" 2>"$erro")"; then
        rm -f "$erro"; printf '%s\n' "$saida"
    else
        local msg; msg="$(cat "$erro")"; rm -f "$erro"
        falha "${msg:-o Web recusou a mudanca nos colaboradores}" "veja os colaboradores com: dgclaw colaborador listar"
    fi
}

# colab_link_url <email>: o endereco do login com o usuario preenchido (https com dominio, ou localhost).
colab_link_url() {
    carregar_env_dgclaw
    local base
    if [ -n "${DGCLAW_DOMINIO:-}" ]; then base="https://$DGCLAW_DOMINIO"; else base="http://127.0.0.1:8300"; fi
    printf '%s/login?usuario=%s' "$base" "$(jq -rn --arg e "$1" '$e | @uri')"
}

# _colab_imprime_convite <json>: o texto pronto para o dono repassar, com a senha temporaria (que so aparece agora).
_colab_imprime_convite() {
    local json="$1" email nomes senha expira link
    email="$(jq -r '.colaborador.email' <<<"$json")"
    nomes="$(jq -r '.agentes_nomes | join(", ")' <<<"$json")"
    senha="$(jq -r '.senha_temporaria' <<<"$json")"
    expira="$(jq -r '.expira' <<<"$json" | cut -c1-10)"
    link="$(colab_link_url "$email")"
    info "Texto do convite, para o dono mandar a pessoa (a senha temporaria aparece SO agora; se perder, use: dgclaw colaborador reenviar $email):"
    printf '\n'
    printf 'Ola! Voce foi convidado(a) para conversar com %s no DG Claw.\n\n' "$nomes"
    printf 'Endereco: %s\nLogin: %s\nSenha temporaria: %s\n\n' "$link" "$email" "$senha"
    printf 'A senha temporaria vale ate %s (7 dias). No primeiro acesso voce cria a sua propria senha.\n\n' "$expira"
}

colaborador_listar() {
    [ $# -eq 0 ] || falha "opcao desconhecida: $1" "use: dgclaw colaborador listar"
    exigir_ferramentas jq node
    local json; json="$(_colab_node listar)"
    if [ "$(jq '.colaboradores | length' <<<"$json")" -eq 0 ]; then info "nenhum colaborador convidado ainda."; return 0; fi
    printf '%-32s %-20s %-28s %-24s %s\n' "EMAIL" "NOME" "ESTADO" "AGENTES" "ULTIMO ACESSO"
    jq -r '.colaboradores[] | [.email, (if (.nome // "") == "" then "-" else .nome end), .estado, (.agentes | join(",")), (if .ultimo_login then (.ultimo_login / 1000 | todate | .[0:16]) else "nunca" end)] | @tsv' <<<"$json" \
        | while IFS=$'\t' read -r e n es ag u; do printf '%-32s %-20s %-28s %-24s %s\n' "$e" "${n:--}" "$es" "$ag" "$u"; done
}

# colaborador_convidar <email> --agentes <a,b> [--nome <nome>]
colaborador_convidar() {
    local email="" agentes="" nome=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --agentes) [ $# -ge 2 ] || falha "--agentes precisa da lista (a,b,c)." "exemplo: dgclaw colaborador convidar maria@x.com --agentes ana,bob"; agentes="$2"; shift 2 ;;
            --nome) [ $# -ge 2 ] || falha "--nome precisa do nome." "exemplo: --nome \"Maria\""; nome="$2"; shift 2 ;;
            -*) falha "opcao desconhecida: $1" "use: dgclaw colaborador convidar <email> --agentes <a,b> [--nome <nome>]" ;;
            *) [ -z "$email" ] || falha "so um e-mail por vez." "use: dgclaw colaborador convidar <email> --agentes <a,b> [--nome <nome>]"; email="$1"; shift ;;
        esac
    done
    [ -n "$email" ] || falha "faltou o e-mail da pessoa." "exemplo: dgclaw colaborador convidar maria@x.com --agentes ana"
    [ -n "$agentes" ] || falha "faltou dizer os agentes (--agentes a,b)." "veja os agentes com: dgclaw agente listar"
    exigir_ferramentas jq node
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] convidaria $email para os agentes $agentes"; return 0; fi
    local json; json="$(_colab_node convidar "$(jq -nc --arg e "$email" --arg n "$nome" --arg a "$agentes" '{email: $e, nome: $n, agentes: ($a | split(",") | map(select(. != "")))}')")"
    ok "convite criado para $email (agentes: $(jq -r '.colaborador.agentes | join(", ")' <<<"$json"))"
    _colab_imprime_convite "$json"
}

colaborador_agentes() {
    [ $# -eq 2 ] || falha "use: dgclaw colaborador agentes <email> <a,b,c>" "para tirar todo o acesso, use: dgclaw colaborador revogar <email>"
    exigir_ferramentas jq node
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] deixaria $1 com os agentes $2"; return 0; fi
    local json; json="$(_colab_node agentes "$(jq -nc --arg e "$1" --arg a "$2" '{email: $e, agentes: ($a | split(",") | map(select(. != "")))}')")"
    ok "agentes de $1: $(jq -r '.colaborador.agentes | join(", ")' <<<"$json") (vale no proximo clique da pessoa, sem derrubar a sessao)"
}

colaborador_reenviar() {
    [ $# -eq 1 ] || falha "use: dgclaw colaborador reenviar <email>" "veja os colaboradores com: dgclaw colaborador listar"
    exigir_ferramentas jq node
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] geraria uma senha temporaria nova para $1 e derrubaria as sessoes dele"; return 0; fi
    local json; json="$(_colab_node reenviar "$(jq -nc --arg e "$1" '{email: $e}')")"
    ok "convite reenviado a $1 (as sessoes abertas dele caem; ele cria a senha de novo)"
    _colab_imprime_convite "$json"
}

colaborador_revogar() {
    [ $# -eq 1 ] || falha "use: dgclaw colaborador revogar <email>" "veja os colaboradores com: dgclaw colaborador listar"
    exigir_ferramentas jq node
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] revogaria o acesso de $1"; return 0; fi
    _colab_node revogar "$(jq -nc --arg e "$1" '{email: $e}')" >/dev/null
    ok "acesso de $1 revogado (a sessao dele cai no proximo clique; o registro fica na lista, com a data)"
}
