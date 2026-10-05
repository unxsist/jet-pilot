# Third-party themes

JET Pilot's curated built-in themes are converted from the upstream projects
below by `scripts/convert-themes.mjs`, which downloads each source at the
pinned ref, checks that it is MIT licensed and runs it through the app's own
importer. The generated files live in `src/lib/themes/builtin/themes/`. All
of them are used under the MIT licence; the copyright notices are reproduced
here as the licence requires.

| Theme | Upstream | Pinned ref | Licence | Copyright |
|---|---|---|---|---|
| Catppuccin (Latte, Mocha) | [catppuccin/vscode](https://github.com/catppuccin/vscode), via Open VSX `Catppuccin.catppuccin-vsc` | 3.19.0 | MIT | Copyright (c) 2021 Catppuccin |
| Tokyo Night (Night, Light) | [tokyo-night/tokyo-night-vscode-theme](https://github.com/tokyo-night/tokyo-night-vscode-theme) | `7c0f11eaef322f293621ca7befe462214b7ea468` | MIT | Copyright (c) 2018-present Enkia |
| Dracula | [dracula/visual-studio-code](https://github.com/dracula/visual-studio-code), via Open VSX `dracula-theme.theme-dracula` | 2.25.1 | MIT | Copyright (c) 2016 Dracula Theme |
| Nord | [nordtheme/visual-studio-code](https://github.com/nordtheme/visual-studio-code) | `69b80f5196b8c3feb6df7f67e4225adb3040e3fb` (v0.19.0) | MIT | Copyright (c) 2016-present Sven Greb |
| GitHub (Light Default, Dark Default) | [primer/github-vscode-theme](https://github.com/primer/github-vscode-theme), via Open VSX `GitHub.github-vscode-theme` | 6.3.5 | MIT | Copyright (c) 2020 Primer |
| One Dark Pro | [Binaryify/OneDark-Pro](https://github.com/Binaryify/OneDark-Pro) | `36088915dd40c34fce2780065e1eca0f3ec91e8b` (3.20.2) | MIT | Copyright (c) 2013-2022 Binaryify |
| Rosé Pine (Dawn, Main) | [rose-pine/vscode](https://github.com/rose-pine/vscode) | `6b51224aa5936d3fc18e270ab35cde0a71fecf29` (v2.15.2) | MIT | Copyright (c) 2021 Rosé Pine |
| Gruvbox (Light Medium, Dark Medium) | [jdinhify/vscode-theme-gruvbox](https://github.com/jdinhify/vscode-theme-gruvbox), via Open VSX `jdinhlife.gruvbox` | 1.29.1 | MIT | Copyright © 2017 JD |

The test fixture `tests/unit/themes/fixtures/dracula-color-theme.json` is
Dracula 2.25.1 (MIT, Copyright (c) 2016 Dracula Theme).

## Built-in palettes and theme derivation

The built-in palettes Blossom, Grove, Ocean, Ember and Iris
(`src/lib/themes/builtin/themes/{blossom,grove,ocean,ember,iris}.json`) and
parts of the theme engine in `src/lib/themes/` (the palette derivation, the
OKLCH and contrast maths, the theme file rules, and the VS Code import
mapping and light / dark pairing) are derived from
[pingdotgg/t3code](https://github.com/pingdotgg/t3code) at
`250e052f44dd313b658abebc707242a7b25be340`
(`packages/shared/src/themePalettes.ts`, `apps/web/src/themePalette.ts`,
`apps/web/src/vscodeThemeImport.ts`), used under the MIT licence:

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## MIT licence (curated themes)

The licence text that goes with the copyright notices in the table above:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
