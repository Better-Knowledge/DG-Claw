#!/usr/bin/env bash
# lib/skills.sh: o catalogo de skills compartilhadas, em /var/lib/dgclaw/skills (web/docs/SKILLS-POR-ESCOPO.md).
#
#   globais/<skill>/SKILL.md          toda pessoa, se o papel do agente liberar
#   grupos/<grupo>/<skill>/SKILL.md   as pessoas do grupo, se o papel liberar
#   agentes/<slug>/<skill>/SKILL.md   so aquele agente
#
# A pasta e montada SO LEITURA em /run/dgclaw/skills dentro de cada container; o que o agente enxerga em
# ~/.claude/skills sao links para as skills que o papel dele (e os grupos da pessoa) liberam. Skill e codigo
# que o modelo le e segue: so o dono publica nos escopos compartilhados; o agente propoe (pela rota de dados,
# com aprovacao). Arquivos ficam legiveis por todos (755/644): o agente e um uid comum dentro do container e
# precisa ler; por isso NENHUM segredo entra numa skill (o publicar recusa o que parecer segredo).
# Precisa de lib/comum.sh carregado antes, e do jq.

RX_NOME_SKILL='^[a-z][a-z0-9-]{0,39}$'
SKILL_MAX_BYTES=2097152   # 2 MB por skill (pasta inteira)

skills_garantir_pastas() {
    local d
    for d in "$DG_SKILLS_DIR" "$DG_SKILLS_DIR/globais" "$DG_SKILLS_DIR/grupos" "$DG_SKILLS_DIR/agentes"; do
        if [ ! -d "$d" ]; then
            if [ "$ENSAIO" = 1 ]; then printf '   [ensaio] criaria a pasta %s (modo 755)\n' "$d"; continue; fi
            mkdir -p "$d" && chmod 755 "$d"
        fi
    done
}

# skills_escopo_pasta <escopo>: imprime a pasta do escopo (global | grupo:<g> | agente:<slug>) ou falha.
skills_escopo_pasta() {
    case "$1" in
        global) printf '%s/globais' "$DG_SKILLS_DIR" ;;
        grupo:*) local g="${1#grupo:}"; [[ "$g" =~ ^[a-z][a-z0-9_-]{0,39}$ ]] || falha "o grupo '$g' nao e um nome valido." "use o nome do grupo como esta em /etc/dgclaw/papeis.json (ex.: --escopo grupo:financeiro)"
            printf '%s/grupos/%s' "$DG_SKILLS_DIR" "$g" ;;
        agente:*) local s="${1#agente:}"; [[ "$s" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || falha "o agente '$s' nao e um slug valido." "veja os agentes com: dgclaw agente listar"
            printf '%s/agentes/%s' "$DG_SKILLS_DIR" "$s" ;;
        *) falha "o escopo '$1' nao existe." "use --escopo global, --escopo grupo:<grupo> ou --escopo agente:<slug>" ;;
    esac
}

# skills_conferir_pasta <pasta de origem> <nome>: recusa o que nao pode virar skill compartilhada.
skills_conferir_pasta() {
    local origem="$1" nome="$2" bytes achado
    [ -d "$origem" ] || falha "a pasta '$origem' nao existe." "aponte a pasta da skill (a que tem o SKILL.md)"
    [ -f "$origem/SKILL.md" ] || falha "a pasta '$origem' nao tem SKILL.md." "uma skill e uma pasta com SKILL.md dentro"
    if find "$origem" -type l | grep -q .; then falha "a pasta '$origem' tem atalho (link simbolico), e skill compartilhada nao pode ter." "troque o atalho pelo arquivo"; fi
    if find "$origem" -type f ! -name '*.md' ! -name '*.txt' ! -name '*.json' ! -name '*.csv' ! -name '*.yaml' ! -name '*.yml' ! -name '*.html' ! -name '*.py' ! -name '*.sh' ! -name '*.mjs' ! -name '*.js' | grep -q .; then
        falha "a pasta '$origem' tem arquivo de tipo que a skill compartilhada nao aceita (so texto: md, txt, json, csv, yaml, html, py, sh, js, mjs)." "tire os outros arquivos"
    fi
    bytes="$(du -sb "$origem" | cut -f1)"
    [ "$bytes" -le "$SKILL_MAX_BYTES" ] || falha "a pasta '$origem' tem $bytes bytes; o teto de uma skill compartilhada e $SKILL_MAX_BYTES (2 MB)." "tire o que nao e roteiro"
    # O nome no frontmatter precisa ser o nome da pasta (e o que o Claude Code mostra).
    achado="$(sed -n '1,/^---$/{s/^name:[[:space:]]*//p}' "$origem/SKILL.md" | head -1 | tr -d '\r')"
    [ "$achado" = "$nome" ] || falha "o SKILL.md diz 'name: ${achado:-(nada)}', mas a skill se chama '$nome'." "corrija o name no frontmatter do SKILL.md para $nome"
    # Segredo nunca entra em skill: o arquivo fica legivel por todo agente que a recebe.
    if grep -rEIn -e 'sk-[A-Za-z0-9_-]{16,}' -e 'xox[abp]-[A-Za-z0-9-]{10,}' -e 'ghp_[A-Za-z0-9]{20,}' -e 'AKIA[0-9A-Z]{16}' -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' -e '(api[_-]?key|token|senha|password|secret)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_./+=-]{12,}' "$origem" >/dev/null; then
        falha "a pasta '$origem' parece ter um segredo (chave, token ou senha)." "tire o valor; a skill diz ONDE pegar a chave (no cofre), nunca o valor"
    fi
}

# skills_publicar <pasta> <escopo> [nome]: copia a skill para o catalogo (755/644, root), substituindo a versao anterior.
skills_publicar() {
    local origem="$1" escopo="$2" nome="${3:-$(basename "$1")}" destino pasta tmp
    [[ "$nome" =~ $RX_NOME_SKILL ]] || falha "o nome '$nome' nao serve: use de 1 a 40 caracteres entre letras minusculas, numeros e hifen, comecando por letra." "exemplo: fechamento-mensal"
    pasta="$(skills_escopo_pasta "$escopo")"
    skills_conferir_pasta "$origem" "$nome"
    destino="$pasta/$nome"
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] publicaria a skill $nome em ${destino#"$R"} (755/644, root)"; return 0; fi
    skills_garantir_pastas
    mkdir -p "$pasta" && chmod 755 "$pasta"
    tmp="$(mktemp -d "$pasta/.$nome.XXXXXX")"
    cp -R "$origem/." "$tmp/"
    find "$tmp" -type d -exec chmod 755 {} +
    find "$tmp" -type f -exec chmod 644 {} +
    chown -R 0:0 "$tmp"
    rm -rf "$destino"
    mv "$tmp" "$destino"
}

# skills_remover <nome> <escopo>: tira a skill do catalogo (a pasta vai para skills-aposentadas).
skills_remover() {
    local nome="$1" escopo="$2" pasta destino
    [[ "$nome" =~ $RX_NOME_SKILL ]] || falha "o nome '$nome' nao e valido." "veja as skills com: dgclaw skill listar"
    pasta="$(skills_escopo_pasta "$escopo")"
    [ -d "$pasta/$nome" ] || falha "nao ha a skill '$nome' no escopo $escopo." "veja as skills com: dgclaw skill listar"
    destino="$DG_LIB/skills-aposentadas/$nome-$(date +%Y%m%d-%H%M%S)"
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] moveria ${pasta#"$R"}/$nome para ${destino#"$R"}"; return 0; fi
    mkdir -p "$(dirname "$destino")" && chmod 700 "$(dirname "$destino")"
    mv "$pasta/$nome" "$destino"
}

# skills_listar_tsv: escopo<TAB>nome<TAB>caminho relativo, uma por linha.
skills_listar_tsv() {
    local d n
    [ -d "$DG_SKILLS_DIR" ] || return 0
    for d in "$DG_SKILLS_DIR"/globais/*/; do [ -f "$d/SKILL.md" ] && printf 'global\t%s\tglobais/%s\n' "$(basename "$d")" "$(basename "$d")"; done
    for d in "$DG_SKILLS_DIR"/grupos/*/*/; do [ -f "$d/SKILL.md" ] && n="$(basename "$d")" && printf 'grupo:%s\t%s\tgrupos/%s/%s\n' "$(basename "$(dirname "$d")")" "$n" "$(basename "$(dirname "$d")")" "$n"; done
    for d in "$DG_SKILLS_DIR"/agentes/*/*/; do [ -f "$d/SKILL.md" ] && n="$(basename "$d")" && printf 'agente:%s\t%s\tagentes/%s/%s\n' "$(basename "$(dirname "$d")")" "$n" "$(basename "$(dirname "$d")")" "$n"; done
    return 0
}

# skills_permitidas <slug>: os caminhos relativos (globais/x, grupos/g/x, agentes/slug/x) que o agente recebe,
# um por linha, pela politica de /etc/dgclaw/papeis.json: o papel lista as skills (ou "*"); a pessoa pode
# negar; as do grupo exigem a pessoa no grupo; as do proprio agente sempre entram. Pessoa desligada: nada.
# Sem papeis.json valido ou agente fora dele: so as proprias.
skills_permitidas() {
    local slug="$1" linha escopo nome rel grupo
    [[ "$slug" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || return 0
    local pol="" pessoa="" papel="" estado="ativa" grupos="" papel_skills="" pessoa_skills=""
    if [ -s "$DG_PAPEIS_JSON" ] && pol="$(jq -c --arg s "$slug" '
        (.agentes[$s] // null) as $a
        | if $a == null then null else
          {pessoa: $a.pessoa, papel: $a.papel,
           estado: (.pessoas[$a.pessoa].estado // "ativa"),
           grupos: ((.pessoas[$a.pessoa].grupos // []) | join(" ")),
           papel_skills: ((.papeis[$a.papel].skills // []) | join(" ")),
           pessoa_skills: ((.pessoas[$a.pessoa].skills // {}) | to_entries | map("\(.key)=\(.value)") | join(" "))} end' "$DG_PAPEIS_JSON" 2>/dev/null)" && [ "$pol" != null ]; then
        pessoa="$(jq -r .pessoa <<<"$pol")"; papel="$(jq -r .papel <<<"$pol")"; estado="$(jq -r .estado <<<"$pol")"
        grupos="$(jq -r .grupos <<<"$pol")"; papel_skills="$(jq -r .papel_skills <<<"$pol")"; pessoa_skills="$(jq -r .pessoa_skills <<<"$pol")"
    fi
    [ "$estado" != desligada ] || { skills_listar_tsv | awk -F'\t' -v s="agente:$slug" '$1 == s && 0'; return 0; }
    while IFS=$'\t' read -r escopo nome rel; do
        [ -n "$nome" ] || continue
        case "$escopo" in
            agente:*) [ "$escopo" = "agente:$slug" ] && printf '%s\n' "$rel"; continue ;;
        esac
        [ -n "$papel" ] || continue
        # a pessoa nega por nome?
        case " $pessoa_skills " in *" $nome=negado "*) continue ;; esac
        # o papel libera por nome ou por "*"?
        case " $papel_skills " in *" $nome "*|*" * "*) ;; *) continue ;; esac
        if [ "$escopo" != global ]; then
            grupo="${escopo#grupo:}"
            case " $grupos " in *" $grupo "*) ;; *) continue ;; esac
        fi
        printf '%s\n' "$rel"
    done < <(skills_listar_tsv)
}
