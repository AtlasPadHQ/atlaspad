# roboto-flex-wordmark.woff2

A 3.5 KB subset of **Roboto Flex** (The Roboto Flex Project Authors, SIL Open Font License 1.1: see
[LICENSES/OFL-1.1-RobotoFlex.txt](../../../LICENSES/OFL-1.1-RobotoFlex.txt)) holding only the glyphs of `ATLASPAD` (A D L P S T) with the `wght` and
`wdth` axes. Downloaded from Google Fonts (`css2?family=Roboto+Flex:wdth,wght@100..151,400..800&text=ATLASPAD`).

Why: the wordmark and the map watermark are the only text that uses `font-stretch` (118–120 %). Loading the body font
without the `wdth` axis cuts it from 196 KB to 85 KB (latin woff2), which matters on slow mobile connections
(INTEGRATION §8, LCP). This file is served under its own family name, `CS Wordmark` (src/styles/global.css), so it can
never stand in for body text.
