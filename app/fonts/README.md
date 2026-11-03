# Self-hosted faces

`app/layout.tsx` loads these with `next/font/local` instead of `next/font/google`.
Google answers a small share of `css2` requests with extensionless
`fonts.gstatic.com/l/font?kit=…&skey=…&v=…` URLs; Turbopack reads the loader's
own options as a query string, the `&` splits it, and the build fails with
`next/font/google queries have exactly one entry` (vercel/next.js#99114). A
build now needs nothing from Google.

| File | Family | Weight | Subset | Source |
| --- | --- | --- | --- | --- |
| `space-grotesk-latin.woff2` | Space Grotesk | 300–700 (variable) | latin | `https://fonts.gstatic.com/s/spacegrotesk/v22/V8mDoQDjQSkFtoMM3T6r8E7mPbF4Cw.woff2` |
| `anton-latin.woff2` | Anton | 400 | latin | `https://fonts.gstatic.com/s/anton/v27/1Ptgg87LROyAm3Kz-C8.woff2` |

Both are Google Fonts' own latin subsets, unmodified, licensed under the SIL
Open Font License 1.1 — see `OFL-SpaceGrotesk.txt` and `OFL-Anton.txt`.

Latin covers `U+0000-00FF` plus common punctuation, which is what the interface
renders. `next/font/local` cannot give one weight several files with their own
`unicode-range`, so the latin-ext and Vietnamese subsets are not shipped: a name
that needs those glyphs falls back to the font stack's next face. To add a
subset, vendor it as its own family and set its `unicode-range` in
`app/globals.css`.
