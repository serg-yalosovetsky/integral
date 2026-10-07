# integral

Один HUD над промптом Claude Code (serg/tasks#1599). Заменяет `context-bar-compact` и `mcp-doctor`.

```
█████████████───────────────────────░░░ 37% > ↓ !
▀▀▀▀▀▀▀▔▔▔▔▔▔▔▔▔▔▔▔▔   ▀▀▀▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔   ✕ coord reconnect   🔑 figma auth   +2
● Пишу тесты  ━━━━━──────── 2/7
```

- **Строка 1 — контекст.** Полоса по потребителям; `37%` нажимается и по кругу называет
  потребителей от крупнейшего (`messages 31%`, кусок полосы подсвечен). `>` — полная легенда
  (`<` закрывает), `↓` — `/compact` (подсвечен у порога автокомпакта), `!` — чекпоинт
  (`CHECKPOINT_PROMPT`). Пока идёт ход, значки тусклые и не нажимаются.
- **Строка 2 — лимиты + MCP.** Полоски 5h и 7d без подписей, цвет — темп (used / доля прошедшего
  окна: ≤1 зелёный, >1 жёлтый, >2 или ≥80% красный). MCP-проблемы справа с кнопками
  reconnect/auth, лишнее — `+N`. Всё в порядке и нет подписки — строки нет.
- **Строка 3 — план.** Только пока открыт список TodoWrite / TaskCreate+TaskUpdate.

Команда: `/integral` (скрыть/показать, запоминается), `/integral more`, `/integral mcp`,
`/integral mcp check`, `/integral plan off|on`.

Ограничение: у `Button` в этой версии API нет цвета, поэтому `37%` рисуется цветом темы, а цвет
уровня проявляется при наведении.

## Атрибуция

Логика строки плана (`hooks/plan.ts`) адаптирована из
[hoobnn/todo-bar](https://github.com/hoobnn/hoobnn-agent-mods) (`hooks/board.ts`), лицензия MIT:

```
MIT License

Copyright (c) 2026 hoobnn

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
```
