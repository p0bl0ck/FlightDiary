# Airline logos

These PNGs come from https://github.com/spydogenesis/airlines-logo,
folder `airlines-logo/200x200_v2`, pinned to commit
`8c5f1ae3d25538bd1b649a7ad85b902528c612b6`.
Only the 10 airlines currently configured in `data/airlines.json` are bundled.
Despite the upstream folder name, these original images are 70×70 pixels.
They are displayed at 24×24 CSS pixels.

Upstream states that airline logos are typically trademarked by their respective
airlines and should be used in accordance with each airline's brand guidelines
and applicable laws. This collection does not establish unrestricted reuse rights
for the logos; ownership remains with the respective rights holders.

To add a logo, download the matching two-character uppercase IATA filename from:

`https://raw.githubusercontent.com/spydogenesis/airlines-logo/8c5f1ae3d25538bd1b649a7ad85b902528c612b6/airlines-logo/200x200_v2/<IATA>.png`

Verify it is a valid PNG depicting the intended airline, then save it in this
folder as `<IATA>.png`. Letters and digits are supported. Keep the original image
and aspect ratio. If absent upstream, leave the airline text-only. When updating
from a newer revision, review the images and upstream notices and record the new
revision here. No downloads occur at runtime.
