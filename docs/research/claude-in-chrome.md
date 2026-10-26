# Исследование: как устроено расширение Claude in Chrome

Источник: код расширения v1.0.102, установленного в Brave пользователя (`Default\Extensions\fcoeoabgfenejglbffodgkkbkcdhcgfn`). Разбор от 2026-10-26, только чтение кода, ничего не запускали. Пометка «(не проверено)» означает вывод из кода без эксперимента.

## Инструменты агента

- `computer`: действия left/right/double/triple_click, type, key, scroll, scroll_to, hover, left_click_drag, wait, screenshot, zoom. Клик по координатам или по `ref`.
- `read_page(filter: interactive|all, depth=15, ref_id, max_chars=50000)`: дерево элементов.
- `find(query)`: поиск элементов на естественном языке, **вызывает отдельную модель**.
- `form_input(ref, value)`, `get_page_text`, `navigate`, `javascript_tool`, `file_upload` (base64), `upload_image`.
- `browser_batch(actions[])`: несколько действий за один вызов, остановка на первой ошибке.
- Вкладки (`tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`), консоль, сеть, `resize_window`, `gif_creator`.

## Представление страницы

- Это не настоящее accessibility-дерево, а обход DOM по `element.children`. Роль берётся из атрибута `role` или по тегу. Имя: aria-label, placeholder, title, alt, `label[for]`, текст. `aria-labelledby` не учитывается.
- `filter="interactive"`: только видимые интерактивные элементы в viewport. По умолчанию `all`, вся страница до 50 тыс. символов.
- Ref стабильны: `window.__claudeElementMap[ref] = new WeakRef(el)` и обратный WeakMap. Если элемент исчез, возвращается ошибка `ref_stale`.
- iframe и shadow DOM фактически не обходятся.
- Пароли, OTP и номера карт скрываются.
- Формат вывода:
  ```
  navigation [ref_1]
   link "Home" [ref_2] href="/"
   textbox "Search" [ref_4] type="text" placeholder="Search"
   button "Sign in" [ref_3] type="button"
  Viewport: 1280x720
  ```

## Скриншоты

- CDP `Page.captureScreenshot`, JPEG q=75.
- Размер под бюджет токенов: `ceil(w/28)·ceil(h/28) ≤ 1568`, примерно 1,2 МП. Координаты модели пересчитываются в координаты viewport.
- `zoom` снимает область PNG детально. Меток на скриншоте **нет**.

## Действия

- Клик: доверенный CDP `Input.dispatchMouseEvent`. По ref: `scrollIntoView({block:"center"})`, затем клик в центр прямоугольника. Перекрытие элемента не проверяется.
- `type`: `Input.dispatchKeyEvent` и `Input.insertText`.
- `form_input`: `el.value = …` плюс события `input` и `change`, **без нативного setter**. Для React-полей (Meta Ads), скорее всего, не работает (не проверено).
- `file_upload`: base64 → `DataTransfer` → `input.files`, лимит 10 МБ.

## Ожидание

- Нет ни ожидания сети, ни MutationObserver.
- `navigate` ждёт около 300 мс и не дожидается загрузки.
- После клика возвращается только строка текста. Скриншот приходится запрашивать отдельным вызовом. Автоматически скриншот возвращает только `scroll`, после паузы 200 мс.
- Фиксированные паузы: скрытие индикатора 50 мс, анимация «призрачного курсора» до 250 мс, вокруг клика 200+100 мс.

## Изоляция и безопасность

- Отдельная группа вкладок для агента. Перед каждым действием проверяется, что домен не сменился.
- Сообщает, если клик открыл новую вкладку.
- На странице: подсветка рамкой, кнопка «Stop Claude», призрачный курсор. Всё это скрывается на время скриншота.
- Разрешения по доменам и категориям действий.
- `Emulation.setFocusEmulationEnabled` позволяет работать с фоновыми вкладками.

## Выводы для agent-click

**Берём:**
- стабильные ref через WeakRef и ошибку `ref_stale`;
- фильтр «интерактивное и в viewport»;
- скриншот под бюджет токенов и `zoom`;
- клик по ref: scrollIntoView, центр, доверенный CDP-клик;
- пакетные действия;
- изоляцию вкладок, проверку домена, сообщение о новых вкладках;
- скрытие паролей и карт;
- эмуляцию фокуса.

**Делаем лучше:**
- ждём стабилизации страницы и сразу возвращаем состояние после действия;
- номера на скриншоте совпадают с номерами в списке;
- указываем контекст элемента;
- заполняем через нативный setter;
- обходим iframe и shadow DOM;
- проверяем перекрытие через `elementFromPoint`;
- загружаем файлы по пути через `DOM.setFileInputFiles`;
- не делаем отдельного вызова модели для поиска;
- убираем фиксированные паузы.
