#!/usr/bin/env bash
# Sons de guitarra da página Teoria (static/guitar/38.mp3 … 74.mp3; número = nota MIDI).
# Gravações de guitarra acústica de Nicholaus Brosowsky (tonejs-instruments), licença CC BY 3.0.
# Mesma receita usada no Raspberry Pi: 3,5 s, sem silêncio inicial, fade final, mono, 80 kbps.
# Corre no GitHub Actions (tem ffmpeg); os ficheiros ficam em cache entre publicações.
set -euo pipefail
OUT="${1:-static/guitar}"
mkdir -p "$OUT"
if [ "$(ls "$OUT"/*.mp3 2>/dev/null | wc -l)" -ge 37 ]; then echo "sons já existem (cache)"; exit 0; fi
if ! command -v ffmpeg >/dev/null; then  # o servidor do GitHub nem sempre traz o ffmpeg
  sudo apt-get update -qq && sudo apt-get install -y -qq --no-install-recommends ffmpeg >/dev/null
fi
declare -A PC=([C]=0 [Cs]=1 [D]=2 [Ds]=3 [E]=4 [F]=5 [Fs]=6 [G]=7 [Gs]=8 [A]=9 [As]=10 [B]=11)
TMP=$(mktemp -d)
for n in A2 A3 A4 As2 As3 As4 B2 B3 B4 C3 C4 C5 Cs3 Cs4 Cs5 D2 D3 D4 D5 Ds2 Ds3 Ds4 E2 E3 E4 F2 F3 F4 Fs2 Fs3 Fs4 G2 G3 G4 Gs2 Gs3 Gs4; do
  midi=$(( ${PC[${n%?}]} + 12 * (${n: -1} + 1) ))
  [ -s "$OUT/$midi.mp3" ] && continue
  curl -fsSL -A "Mozilla/5.0" -o "$TMP/$midi.mp3" "https://nbrosowsky.github.io/tonejs-instruments/samples/guitar-acoustic/$n.mp3"
  ffmpeg -loglevel error -y -i "$TMP/$midi.mp3" -t 3.5 \
    -af "silenceremove=start_periods=1:start_threshold=-50dB,afade=t=out:st=2.9:d=0.6" -ac 1 -b:a 80k "$OUT/$midi.mp3"
done
cat > "$OUT/CREDITOS.txt" <<'EOF'
Sons de guitarra acústica (ficheiros 38.mp3 a 74.mp3, número = nota MIDI)

Gravações de Nicholaus Brosowsky, licença Creative Commons Attribution 3.0 (CC BY 3.0)
https://creativecommons.org/licenses/by/3.0/

Alterações: cortadas para 3,5 segundos, convertidas para mono e comprimidas (80 kbps).
EOF
ls "$OUT"/*.mp3 | wc -l
