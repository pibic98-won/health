#!/usr/bin/env bash
# Downloads the (OFL-licensed) Google Fonts used by motion.js into ./fonts
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p fonts; cd fonts
g=https://fonts.gstatic.com/s
curl -sSfo NotoSansKR-400.ttf $g/notosanskr/v39/PbyxFmXiEBPT4ITbgNA5Cgms3VYcOA-vvnIzzuoyeLQ.ttf
curl -sSfo NotoSansKR-700.ttf $g/notosanskr/v39/PbyxFmXiEBPT4ITbgNA5Cgms3VYcOA-vvnIzzg01eLQ.ttf
curl -sSfo NotoSansKR-900.ttf $g/notosanskr/v39/PbyxFmXiEBPT4ITbgNA5Cgms3VYcOA-vvnIzzkM1eLQ.ttf
curl -sSfo BlackHanSans.ttf $g/blackhansans/v24/ea8Aad44WunzF9a-dL6toA8r8nqV.ttf
curl -sSfo ArchivoBlack.ttf $g/archivoblack/v23/HTxqL289NzCGg4MzN6KJ7eW6OYs.ttf
curl -sSfo JetBrainsMono-500.ttf $g/jetbrainsmono/v24/tDbY2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8-qxjPQ.ttf
curl -sSfo JetBrainsMono-800.ttf $g/jetbrainsmono/v24/tDbY2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8SKtjPQ.ttf
curl -sSfo SpaceGrotesk-700.ttf $g/spacegrotesk/v22/V8mQoQDjQSkFtoMM3T6r8E7mF71Q-gOoraIAEj4PVksj.ttf
echo "fonts ready"
